// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Reference interpreter for a Machine. It implements exactly the execution semantics of the generated
// code and drives the simulator; the test suite checks that both produce identical traces.
//
// The engine executes the `Machine` produced by `analyze` (src/model.ts) directly, without generating code.
// It is used in two places:
//   - the simulator in the webview (media/editor.js, via the bundle built by scripts/bundle-webview.js), where
//     the user plays the role of the guards and timers through `EngineHooks`;
//   - the test suite (test/engine-harness.js), which runs the engine and every generated C, C++ and C#
//     variant on the same scenarios and requires identical traces.
// Because of the second use, the structure deliberately mirrors the generated code: methods such as
// `dispatchCore`, `dispatchState`, `handleEvent`, `exitState`, `enterDown`, `enterState`, `enterDefault`,
// `enterHistory`, `enterRegion`, `markCompletion` and `runCompletions` correspond to the generated members of
// the same names, and any change here must be matched in src/generators/ (and vice versa).
//
// Run-time state:
//   - the active configuration is one slot per region (`active[region.index]`): the active direct substate of
//     that region, or null. Region 0 is the top level. With orthogonal regions the configuration is a tree;
//     a state is active exactly when it occupies the slot of its own region.
//   - pending completions (`pending`): states that have completed and whose completion transitions still have
//     to be tried before the current step ends (run-to-completion).
//   - history (`history`): per region, the state most recently exited from it. Because a composite state is
//     always exited together with its whole active subtree, these slots hold the configuration below every
//     composite as it was when that composite was last exited, which is what history pseudostates restore.
//   - `exited`: the outermost state exited by the latest transition of the current step, which tells an
//     orthogonal state whether a transition taken in one region has left it (see dispatchState).
//   - timers: a generation counter and an armed flag per `MTimer`, so that stale timeouts can be ignored.
//   - the event queue for `post`, and the arguments of the event currently being processed.
//
// Everything observable (guards, actions, traces, timer requests, fired transitions) goes through the
// `EngineHooks` supplied by the caller; the engine itself has no side effects outside its own state.
import { COMPLETION_EVENT, Guard, MBranch, Machine, MRegion, MState, MTransition } from './model';

/** Kinds of trace record, matching the generated TraceKind enumeration. */
export type TraceKindName = 'Start' | 'Event' | 'Ignored' | 'Transition' | 'Exit' | 'Enter';

/**
 * Callbacks through which the engine interacts with its environment; they play the part of the abstract
 * hooks that the user implements in a subclass of the generated code.
 */
export interface EngineHooks {
    /**
     * Evaluates the guard hook `name` (not yet negated). `args` are the arguments of the triggering event,
     * empty for parameterless events, timeouts and completions.
     */
    guard(name: string, args: unknown[]): boolean;
    /**
     * Runs the action hook `name`. Transition and branch actions receive the event arguments; entry, exit and
     * initial actions always receive an empty list.
     */
    action(name: string, args: unknown[]): void;
    /** Receives the same records as the generated Trace hook; `name` is a state, event or transition label. */
    trace?(kind: TraceKindName, name: string): void;
    /**
     * Requests a timer after a state with a timeout has been entered (after its entry actions). When it elapses,
     * the caller should invoke `dispatchTimeout(event, generation)` with the generation passed here.
     */
    startTimer?(event: string, milliseconds: number, generation: number): void;
    /**
     * Cancels the timer of `event`; called when its state is exited (before the exit actions), and by `start` for
     * every timer that is still armed.
     */
    cancelTimer?(event: string): void;
    /** Reports the diagram id of every transition or choice branch taken. */
    fired?(id: string): void;
}

/** An event waiting in the queue filled by `post`. */
interface QueuedEvent {
    event: string;
    args: unknown[];
}

/**
 * Number of completion transitions one step may fire before the engine gives up. Generated code has no such
 * limit: there, a cycle of completion transitions whose guards stay true simply never returns (analyze
 * rejects cycles without guards). The limit keeps the simulator responsive when that happens.
 */
export const COMPLETION_LIMIT = 1000;

/**
 * Thrown by `start`, `dispatch` and `dispatchTimeout` when the completion transitions of one step do not
 * settle within COMPLETION_LIMIT firings, i.e. they almost certainly loop for ever (a cycle of guarded
 * completion transitions whose guards stay true). The pending completions and queued events of the step are
 * discarded; the machine stays in the configuration reached so far and can continue with the next event.
 */
export class CompletionLoopError extends Error {
    constructor() {
        super(`Completion transitions fired ${COMPLETION_LIMIT} times in one step without settling; they probably form an endless loop. Check the guards of the completion transitions.`);
        this.name = 'CompletionLoopError';
    }
}

/**
 * Executes a `Machine` with the same semantics as the generated code. Create it, call `start()`, then feed it
 * events with `dispatch`, `dispatchTimeout` and `post`. Hooks must not call `start` or `dispatch`
 * re-entrantly; they may call `post` to raise follow-up events.
 */
export class Engine {
    /** Active substate per region index (null = region inactive); index 0 is the top level. */
    private active: (MState | null)[];
    /** States that have completed and whose completion transitions have not been tried yet. */
    private readonly pending = new Set<MState>();
    /**
     * Per region index: the state most recently exited from that region (null = none since Start). Read by
     * `enterHistory` when a composite is entered through its history pseudostate.
     */
    private history: (MState | null)[];
    /**
     * Outermost state exited by the latest transition of the current step (null at the start of each step).
     * Set by exitState: the exit root's exitState call finishes last.
     */
    private exited: MState | null = null;
    /** FIFO of posted events, bounded by `machine.queueCapacity`. */
    private readonly queue: QueuedEvent[] = [];
    /** Per timer index: incremented on every start, so that a late timeout of an earlier start is recognised. */
    private readonly generation: number[];
    /** Per timer index: true from the start of the timer until it is cancelled or its timeout is dispatched. */
    private readonly armed: boolean[];
    /**
     * Candidate transitions keyed by `<source state index>:<event>`, in the priority order of
     * `machine.transitions` (may-not-fire candidates first, then diagram order).
     */
    private readonly handlers = new Map<string, MTransition[]>();
    /** Arguments of the event being processed; passed to guards and transition/branch actions. */
    private args: unknown[] = [];

    /**
     * @param machine The analysed machine to execute.
     * @param hooks Guard, action, trace, timer and coverage callbacks.
     */
    constructor(readonly machine: Machine, private readonly hooks: EngineHooks) {
        this.active = machine.regions.map(() => null);
        this.history = machine.regions.map(() => null);
        this.generation = machine.timers.map(() => 0);
        this.armed = machine.timers.map(() => false);
        for (const t of machine.transitions) {
            const key = `${t.source.index}:${t.event}`;
            this.handlers.set(key, [...(this.handlers.get(key) ?? []), t]);
        }
    }

    // ------------------------------------------------------------- public API (mirrors generated code)

    /**
     * Start(): a full reset followed by the initial entry. Every timer that is still armed is disarmed, gets a
     * new generation (so that an outstanding `dispatchTimeout` for it is stale) and is cancelled through the
     * `cancelTimer` hook; the configuration, recorded history, pending completions and the queue are cleared.
     * Then the top-level initial transition's actions run and its target is entered (following default
     * transitions down to the leaves), and completions and queued events are processed like after any
     * dispatched event. Start is a reset, not a transition: the states that were active before are not exited,
     * so their exit actions do not run.
     */
    start(): void {
        for (const timer of this.machine.timers) {
            if (this.armed[timer.index]) {
                this.armed[timer.index] = false;
                this.generation[timer.index]++;
                this.hooks.cancelTimer?.(timer.event);
            }
        }
        this.active = this.machine.regions.map(() => null);
        this.history = this.machine.regions.map(() => null);
        this.pending.clear();
        this.queue.length = 0;
        this.args = [];
        this.trace('Start', this.machine.name);
        this.machine.initial.actions.forEach(a => this.hooks.action(a, []));
        this.enterDown(null, this.machine.initial.target, false);
        this.runCompletions();
        this.drainQueue();
    }

    /**
     * Dispatch(event) for events without parameters, or the typed Dispatch<Event>(args) when `typed`.
     * The event is processed to completion (including resulting completion transitions), then the event queue
     * is drained, before the call returns. A timeout event may be dispatched directly too (to drive timeouts
     * by hand); this skips the generation check of `dispatchTimeout` but, like it, disarms the timer.
     *
     * @returns True if some transition handled the event; false if no transition was enabled or the call was
     *          rejected (unknown event, the internal completion event, or typed/untyped mismatch).
     */
    dispatch(event: string, args: unknown[] = [], typed = false): boolean {
        if (this.rejected(event, typed)) {
            return false;
        }
        this.args = args;
        const handled = this.dispatchCore(event);
        this.drainQueue();
        return handled;
    }

    /**
     * DispatchTimeout: dispatches a timeout reported by a timer started through `startTimer`. A timer is
     * one-shot: the timeout is accepted only while the timer is armed and the generation matches, and accepting
     * it disarms the timer, so a repeated call for the same start is ignored even when the timeout's
     * transition did not fire (guard false) or was internal.
     */
    dispatchTimeout(event: string, generation: number): boolean {
        const timer = this.machine.timers.find(t => t.event === event);
        // A timer that is not armed has been cancelled (its state was left) or has already fired; a different
        // generation means the state has been left and re-entered since this timer was started. Either way the
        // timeout is stale.
        if (!timer || !this.armed[timer.index] || this.generation[timer.index] !== generation) {
            return false;
        }
        return this.dispatch(event);
    }

    /**
     * Post / Post<Event>: queues an event that is processed after the current one. Like the generated code,
     * which only has Post when the queue option is on, posting is refused when `machine.queue` is false.
     *
     * @returns False if the queue option is off, the event is rejected (see `dispatch`) or the queue is full.
     */
    post(event: string, args: unknown[] = [], typed = false): boolean {
        if (!this.machine.queue || this.rejected(event, typed) || this.queue.length >= this.machine.queueCapacity) {
            return false;
        }
        this.queue.push({ event, args });
        return true;
    }

    /** Innermost active state, following the first region of orthogonal states. */
    current(): MState | null {
        let s = this.active[0];
        while (s && s.regions.length > 0 && this.active[s.regions[0].index]) {
            s = this.active[s.regions[0].index];
        }
        return s;
    }

    /** IsIn(state): true if `state` is active (it occupies the slot of its region). */
    isIn(state: MState): boolean {
        return this.active[state.region.index] === state;
    }

    /** IsFinished(): true once a top-level final state is active. */
    isFinished(): boolean {
        return this.active[0]?.isFinal === true;
    }

    /** All active states (in pre-order). */
    activeStates(): MState[] {
        return this.machine.states.filter(s => this.isIn(s));
    }

    /** Events that some active state could handle right now (ignoring guards). */
    enabledEvents(): Set<string> {
        const result = new Set<string>();
        for (const s of this.activeStates()) {
            for (const t of this.machine.transitions) {
                if (t.source === s && t.kind !== 'completion') {
                    result.add(t.event);
                }
            }
        }
        return result;
    }

    // ------------------------------------------------------------- semantics

    /**
     * True if a public dispatch or post of `event` must be refused: the event is not part of the machine, it is
     * the internal completion event, or it is called through the wrong entry point (events with parameters only
     * through the typed variant, events without parameters only through the untyped one).
     */
    private rejected(event: string, typed: boolean): boolean {
        const params = this.machine.params.get(event);
        return params === undefined || event === COMPLETION_EVENT || (params.length > 0) !== typed;
    }

    private trace(kind: TraceKindName, name: string): void {
        this.hooks.trace?.(kind, name);
    }

    /**
     * Processes one event (whose arguments are already in `this.args`) to completion: offers it to the active
     * configuration from the top-level state down and, if a transition fired, runs the completion transitions
     * that became due. Shared by `dispatch` and `drainQueue`. A timeout event disarms its timer first, however
     * it was dispatched (timers are one-shot).
     */
    private dispatchCore(event: string): boolean {
        const timer = this.machine.timers.find(t => t.event === event);
        if (timer) {
            this.armed[timer.index] = false;
        }
        this.exited = null;
        this.trace('Event', event);
        const top = this.active[0];
        if (top && this.dispatchState(top, event)) {
            this.runCompletions();
            return true;
        }
        this.trace('Ignored', event);
        return false;
    }

    // Offers the event to every active region below `state` first, then to `state` itself.
    // This realises the "innermost first" priority: the recursion reaches the leaves before any ancestor's own
    // transitions are tried, so the event bubbles up only when nothing below handled it. With orthogonal
    // regions every region gets the event in turn (several regions may react to the same event), and each later
    // region sees the configuration left by the earlier ones. If a transition taken in one region exited
    // `state` (its exit root is `state` or an ancestor), the remaining regions are not asked, even when the
    // transition re-entered `state`: the freshly entered regions must not see the same event again.
    private dispatchState(state: MState, event: string): boolean {
        let handled = false;
        for (const r of state.regions) {
            const child = this.active[r.index];
            if (child && this.dispatchState(child, event)) {
                handled = true;
                if (this.left(state)) {
                    return true;
                }
            }
        }
        return handled || this.handleEvent(state, event);
    }

    /**
     * True if the latest transition of this step exited `state`, i.e. its outermost exited state is `state` or
     * one of its ancestors. Only a transition taken below `state` can be the latest one when this is asked:
     * any transition that exits a state makes every dispatchState level up to that state return at once, so
     * no further transition is taken in between.
     */
    private left(state: MState): boolean {
        for (let s: MState | null = state; s; s = s.parent) {
            if (s === this.exited) {
                return true;
            }
        }
        return false;
    }

    /**
     * HandleEvent: tries the transitions of `state` itself (not of its substates or ancestors) for `event`, in
     * priority order, and fires the first enabled one. A transition into a choice point is enabled only if a
     * complete branch path is enabled; otherwise the next candidate is tried (junction semantics).
     *
     * @returns True if a transition fired.
     */
    private handleEvent(state: MState, event: string): boolean {
        for (const t of this.handlers.get(`${state.index}:${event}`) ?? []) {
            if (t.guard && !this.evaluate(t.guard)) {
                continue;
            }
            if (t.branches) {
                if (this.fireBranches(t, t.branches, t.actions, [t.id])) {
                    return true;
                }
                continue;
            }
            this.fire(t);
            return true;
        }
        return false;
    }

    /** Calls the guard hook with the current event arguments and applies the `!` negation. */
    private evaluate(guard: Guard): boolean {
        const result = this.hooks.guard(guard.name, this.args);
        return guard.negate ? !result : result;
    }

    /**
     * Fires a simple (non-compound) transition. An internal transition only runs its actions: nothing is exited
     * or entered, so timers keep running and no completion is triggered. An external transition exits up to
     * (not including) the LCA, runs its actions, and enters the target from below the LCA — restoring the
     * recorded history for a history transition.
     */
    private fire(t: MTransition): void {
        this.hooks.fired?.(t.id);
        if (t.internal) {
            this.trace('Transition', `${t.source.name} (internal)`);
            t.actions.forEach(a => this.hooks.action(a, this.args));
            return;
        }
        this.trace('Transition', `${t.source.name} -> ${t.target.name}${t.history ? ' (history)' : ''}`);
        this.exitTo(t.source, t.lca);
        t.actions.forEach(a => this.hooks.action(a, this.args));
        this.enterDown(t.lca, t.target, t.history);
    }

    /**
     * Selects and fires a path through the choice point(s) of compound transition `t`. All guards on the path are
     * evaluated before anything is exited, so the transition never stops half-way and a branch guard cannot see
     * the effect of the incoming transition's actions. Branches are tried in the order prepared by `analyze`
     * (guarded first, [else] last); if a branch leads into a nested choice point that has no enabled path, the
     * search continues with the following sibling branches.
     *
     * @param prefix Actions of the segments already on the path (incoming transition first), run in order once a
     *               complete path is found.
     * @param path Diagram ids of the segments on the path, reported through `fired` only if the path completes.
     * @returns True if a complete path was found and the transition fired.
     */
    private fireBranches(t: MTransition, branches: MBranch[], prefix: string[], path: string[]): boolean {
        for (const b of branches) {
            if (!b.guard || this.evaluate(b.guard)) {
                if (b.branches) {
                    if (this.fireBranches(t, b.branches, [...prefix, ...b.actions], [...path, b.id])) {
                        return true;
                    }
                } else {
                    // Complete path: perform the whole compound transition from the original source to this
                    // branch's target, with the LCA computed for that pair.
                    [...path, b.id].forEach(id => this.hooks.fired?.(id));
                    this.trace('Transition', `${t.source.name} -> ${b.target!.name}${b.history ? ' (history)' : ''} (choice)`);
                    this.exitTo(t.source, b.lca);
                    [...prefix, ...b.actions].forEach(a => this.hooks.action(a, this.args));
                    this.enterDown(b.lca, b.target!, b.history);
                    return true;
                }
            }
            // The [else] branch is last; if even it could not complete (its nested choice failed), give up.
            if (!b.guard) {
                break;
            }
        }
        return false;
    }

    /**
     * ExitTo: exits everything below `lca` that contains `source`. The outermost such state is the ancestor of
     * `source` (or `source` itself) whose parent is the LCA; exiting it exits all of its active descendants too.
     * When a transition is inherited from a composite source, the active substates are therefore exited as well.
     */
    private exitTo(source: MState, lca: MState | null): void {
        let x = source;
        while (x.parent !== lca) {
            x = x.parent!;
        }
        this.exitState(x);
    }

    /**
     * ExitState: exits `state` and all its active descendants, innermost first. Orthogonal regions are exited
     * last region first (the reverse of the entry order). For the state itself the order is: trace, cancel its
     * timers, run its exit actions (without event arguments), then clear its region slot and record it as the
     * state last exited from that region (for history). Finally `state` becomes `exited`; since the outermost
     * state's call finishes last, `exited` ends up holding the transition's exit root.
     */
    private exitState(state: MState): void {
        for (const r of [...state.regions].reverse()) {
            const child = this.active[r.index];
            if (child) {
                this.exitState(child);
            }
        }
        this.trace('Exit', state.name);
        this.cancelTimers(state);
        state.exit.forEach(a => this.hooks.action(a, []));
        this.active[state.region.index] = null;
        this.history[state.region.index] = state;
        this.exited = state;
    }

    /**
     * EnterDown: enters every state from below `from` down to `target`, outermost first, then completes the
     * entry of `target`: by default (EnterDefault: initial transitions down to the leaves), or for a history
     * transition from the recorded history (EnterHistory, shallow or deep according to the target's history
     * pseudostate). The regions of an orthogonal state on the path are entered in order: those before the
     * region containing the target by default, then that region along the path, then the remaining ones by
     * default.
     *
     * Implemented one level at a time: find the state on the path just below `from`, enter it, and recurse
     * with that state as the new `from`.
     *
     * @param from State that stays active (the LCA, or a region's owner), or null to enter from the top level.
     * @param history Enter `target` through its history pseudostate.
     */
    private enterDown(from: MState | null, target: MState, history: boolean): void {
        let state = target;
        let next: MState | null = null;
        while (state.parent !== from) {
            next = state;
            state = state.parent!;
        }
        this.enterState(state);
        if (!next) {
            if (history) {
                this.enterHistory(state, state.history === 'deep');
            } else {
                this.enterDefault(state);
            }
            return;
        }
        for (const r of state.regions) {
            if (r === next.region) {
                this.enterDown(state, target, history);
            } else {
                this.enterRegion(r);
            }
        }
    }

    /**
     * EnterState: enters `state` itself: occupy its region slot, trace, run its entry actions (without event
     * arguments), then start its timers.
     */
    private enterState(state: MState): void {
        this.active[state.region.index] = state;
        this.trace('Enter', state.name);
        state.entry.forEach(a => this.hooks.action(a, []));
        this.startTimers(state);
    }

    /**
     * EnterDefault: completes the entry of a state that has just been entered. A leaf (simple or final state) may
     * complete immediately; a composite enters each of its regions through the region's initial transition.
     */
    private enterDefault(state: MState): void {
        if (state.regions.length === 0) {
            this.markCompletion(state);
            return;
        }
        state.regions.forEach(r => this.enterRegion(r));
    }

    /**
     * EnterHistory: completes the entry of `state`, which has just been entered through its history
     * pseudostate (or, with `deep`, as part of a deep restoration). Each region re-enters the state last exited
     * from it: with shallow history that state continues with its default entry; with deep history its own
     * regions are restored the same way, recursively, so the whole configuration below the composite is
     * restored, every region of a nested orthogonal state included. A region without a record (the composite
     * has not been exited since Start) is entered by default. A leaf reached this way may complete, as in
     * enterDefault.
     */
    private enterHistory(state: MState, deep: boolean): void {
        for (const r of state.regions) {
            const remembered = this.history[r.index];
            if (!remembered) {
                this.enterRegion(r);
            } else if (deep) {
                this.enterState(remembered);
                this.enterHistory(remembered, true);
            } else {
                this.enterDown(state, remembered, false);
            }
        }
        if (state.regions.length === 0) {
            this.markCompletion(state);
        }
    }

    /** EnterRegion: runs the region's initial-transition actions, then enters its default target. */
    private enterRegion(region: MRegion): void {
        region.initial!.actions.forEach(a => this.hooks.action(a, []));
        this.enterDown(region.owner, region.initial!.target, false);
    }

    /** True if `state` has at least one completion (event-less) transition. */
    private hasCompletion(state: MState): boolean {
        return this.handlers.has(`${state.index}:${COMPLETION_EVENT}`);
    }

    /**
     * MarkCompletion: called when a leaf has been entered. A simple state with completion transitions completes
     * at once. A final state completes its parent composite, provided the parent has completion transitions and
     * every region of the parent has reached a final state (for an orthogonal state, the last region to reach
     * its final state triggers the completion). Completion is not propagated further up: the parent itself is
     * not a leaf, and its own completion transitions are what react to it.
     */
    private markCompletion(state: MState): void {
        if (this.hasCompletion(state)) {
            this.pending.add(state);
            return;
        }
        const owner = state.parent;
        if (state.isFinal && owner && this.hasCompletion(owner) && owner.regions.every(r => this.active[r.index]?.isFinal)) {
            this.pending.add(owner);
        }
    }

    /**
     * RunCompletions: the run-to-completion loop. Repeatedly takes the pending state with the lowest pre-order
     * index (outer states before inner ones, as the generated code scans its pending flags in state order) and,
     * if it is still active, offers it the completion event. Completion events are handled by that state only:
     * they do not bubble to ancestors, and if no completion transition is enabled the completion is discarded
     * and the state stays active. Transitions fired here may mark further states, which are processed in the same
     * loop, so all completions settle before Start/Dispatch return or the next queued event is taken.
     *
     * Unlike the generated code, the loop gives up with a CompletionLoopError after COMPLETION_LIMIT
     * completions, so that a cycle of guarded completion transitions cannot hang the simulator.
     */
    private runCompletions(): void {
        let fired = 0;
        while (this.pending.size > 0) {
            const state = [...this.pending].sort((a, b) => a.index - b.index)[0];
            this.pending.delete(state);
            // The state may have been exited since it was marked (by an earlier completion transition).
            if (this.isIn(state)) {
                if (++fired > COMPLETION_LIMIT) {
                    this.pending.clear();
                    this.queue.length = 0;
                    throw new CompletionLoopError();
                }
                this.args = [];
                this.handleEvent(state, COMPLETION_EVENT);
            }
        }
    }

    /** StartTimers: (re)starts every timer of `state` with a fresh generation; called after its entry actions. */
    private startTimers(state: MState): void {
        for (const timer of this.machine.timers.filter(t => t.state === state)) {
            this.generation[timer.index]++;
            this.armed[timer.index] = true;
            this.hooks.startTimer?.(timer.event, timer.milliseconds, this.generation[timer.index]);
        }
    }

    /** CancelTimers: disarms every timer of `state`; called before its exit actions. */
    private cancelTimers(state: MState): void {
        for (const timer of this.machine.timers.filter(t => t.state === state)) {
            this.armed[timer.index] = false;
            this.hooks.cancelTimer?.(timer.event);
        }
    }

    /**
     * DrainQueue: dispatches queued events in FIFO order, each to completion, until the queue is empty. Events
     * posted while draining are appended and processed in the same loop.
     */
    private drainQueue(): void {
        while (this.queue.length > 0) {
            const entry = this.queue.shift()!;
            this.args = entry.args;
            this.dispatchCore(entry.event);
        }
    }
}
