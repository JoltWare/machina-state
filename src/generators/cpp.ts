// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0
//
// C++ generator: turns an analysed Machine (see model.ts) into one self-contained, header-only C++17 class,
// `<Name>.hpp`. The class has no heap allocation, no exceptions and no RTTI; the user derives from it and
// implements the guards and actions as overrides of pure virtual member functions. It implements exactly
// the semantics of the reference interpreter in engine.ts (which drives the simulator); the test suite
// checks that both produce identical traces. Examples of the output are in test/golden/*.hpp and
// docs/generated/*.hpp.
//
// Shape of the generated header (members in [brackets] only appear when the diagram or an option needs
// them):
//
//   #pragma once
//   #include <cstddef>
//   namespace A::B {                              // only with a diagram namespace (`A.B` becomes `A::B`)
//   class Name {
//     public:
//       enum class State { S1, S2, ..., None };   // states in pre-order (parents first); None = no state
//       enum class Event { E1, ..., [S_After<n>ms], [Completion] };
//       [enum class TraceKind { Start, Event, Ignored, Transition, Exit, Enter };]
//       static constexpr std::size_t kStateCount, kEventCount, kRegionCount, [kTimerCount], [kQueueCapacity];
//       void Start();                              // enter the initial configuration
//       bool Dispatch(Event);                      // events without parameters
//       [bool Dispatch<E>(params...);]             // one typed method per event with parameters
//       [bool DispatchTimeout(Event, unsigned generation);]
//       State Current() const; bool IsIn(State) const; bool IsFinished() const;
//       static ParentOf(State); static StateName(State); static EventName(Event);
//     protected:
//       [Lock()/Unlock()]  [StartTimer()/CancelTimer()]  [virtual Trace()]  [Post()/Post<E>()]
//       virtual bool <guard>(...) = 0;  virtual void <action>(...) = 0;
//     private:
//       [ScopedLock]  [<E>Args, ArgsOf<E>(), args_]  [QueuedEvent, Enqueue(), DrainQueue()]
//       DispatchCore(), DispatchState(), [Fire_<i>()], [RunCompletions(), MarkCompletion(), AllRegionsFinal()],
//       [StartTimers(), CancelTimers(), TimerIndex()], HandleEvent(), RegionOf()/FirstRegionOf()/RegionsOf(),
//       EnterRegion(), entry/exit dispatch, [IsDeepHistory()], ExitState(), EnterDown(), EnterState(),
//       EnterDefault(), [EnterHistory()], Innermost(), and the data members (active_[], [history_[]],
//       [exited_], [pending_], [timers], [queue])
//   };
//   [table style only: `inline` definitions of the constant tables kParent, kEntry, kTransitions, ...]
//   }                                             // end of namespace
//
// Runtime representation. The active configuration is `State active_[kRegionCount]`: one slot per region
// (region 0 is the top level, the regions of one state are consecutive), holding the region's active state
// or None. A state S is active iff `active_[RegionOf(S)] == S`; ancestors are active implicitly because
// they occupy their own region's slot. Composite states own one region, orthogonal states several. With
// history pseudostates, `State history_[kRegionCount]` holds the state last exited from each region; a
// composite is always exited together with its whole active subtree, so these slots describe the
// configuration below every composite at its last exit, which EnterHistory restores.
//
// The two styles have the same interface and identical behaviour; they differ in how the per-state and
// per-transition information is encoded:
//
//   switch  HandleEvent is a nested `switch (state) { switch (event) { ... } }` whose cases contain the
//           complete transition code (guard test, exit, actions, entry) inline. ParentOf, RegionOf,
//           FirstRegionOf, RegionsOf, IsFinalState, IsDeepHistory, EnterRegion, OnEntry/OnExit and the
//           timer helpers are switches too.
//   table   The machine is described by constant arrays (kParent, kEntry, kExit, kRegionOf, kTransitions, ...)
//           and a small fixed interpreter: HandleEvent scans kTransitions, TryRow performs one row. Entry,
//           exit, guard and action cells are member-function pointers, so a cell that needs more than one
//           parameterless call gets a generated private wrapper method (Entry_<S>, Exit_<S>, Init_<r>,
//           Transition_<i>, Guard_<i>).
//
// Options stored on the Machine (Diagram.codegen) change the output as follows:
//
//   trace       adds TraceKind and a virtual, empty-by-default `Trace(kind, name)` hook, called for Start,
//               every dispatched / ignored event, every transition (before any exit), every exit (before
//               the exit actions) and every entry (before the entry actions). Names are string literals.
//               Table rows get an extra `name` column.
//   threadSafe  adds pure virtual `Lock() const` / `Unlock() const` and a private RAII ScopedLock; every
//               public non-static member (Start, Dispatch*, DispatchTimeout, Current, IsIn, IsFinished)
//               holds the lock for its whole duration, so hooks run with the lock held.
//   queue       adds protected `Post(Event)` / `Post<E>(params...)` so hooks can raise follow-up events, a
//               fixed ring buffer of kQueueCapacity QueuedEvent entries inside the object, and a DrainQueue()
//               call at the end of Start and of every public dispatch method.
//
// Other parts are generated only when the diagram uses the corresponding feature: event parameters (typed
// dispatch methods and argument structs), timeouts (timer hooks and generation counters), completion
// transitions (pending flags and RunCompletions), history, orthogonal regions, choice points (Fire_<i>) and
// internal transitions.
//
// Statechart semantics implemented by the generated code (see "Execution Semantics" in docs/manual.tex):
//   - Start is a full reset (configuration, history, timers, completions, queue) followed by the initial
//     entry; the previously active states are not exited.
//   - Run to completion: Start/Dispatch process one event completely, including all completion
//     transitions it causes and then all queued events, before returning.
//   - Innermost first: an event is offered to the active leaf states first and bubbles to their ancestors
//     only if no transition fired; within a state, transitions that may not fire (guarded or with a
//     non-exhaustive choice) are tried before the one that always fires (model.ts sorts them that way).
//   - External transitions exit everything below the least common ancestor (LCA) of source and target,
//     innermost first, run the transition actions, then enter from below the LCA down to the target,
//     outermost first, and continue with default (initial) transitions. Self transitions exit and re-enter.
//   - Internal transitions only run their actions.
//   - Orthogonal regions are entered in order R1..Rn (a region containing the target is entered along the
//     path to it, the others by default) and exited in reverse order. Every region is offered the event;
//     once a transition taken in one region has exited the orthogonal state, the remaining regions are not
//     asked, even if the transition re-entered it.
//   - History is recorded when a composite state is exited and used by transitions that target the history
//     pseudostate: shallow history restores the direct substate, deep history the whole configuration below
//     the composite (every region of nested orthogonal states included).
//   - Choice points have junction semantics: all guards on the path are evaluated before anything is exited.
//   - Timers are one-shot: started on entry, disarmed when cancelled on exit or when their timeout is
//     dispatched; generation numbers make late timeouts harmless.

import { alwaysFires, COMPLETION_EVENT, isExhaustive, Machine, MBranch, MRegion, MState, MTransition, Style } from '../model';
import { Writer } from './writer';

/**
 * Ancestor of `source` directly below `lca`: the state whose exit leaves everything the transition leaves.
 *
 * Exiting this one state (with its active descendants, innermost first) exits exactly the states between the
 * source and the LCA. `lca` must be a proper ancestor of `source` or null (the top level), which model.ts
 * guarantees, so the loop always terminates. For a self transition (`lca` is the source's parent) the result
 * is the source itself. Also used by the C and C# generators.
 */
export function exitRoot(source: MState, lca: MState | null): MState {
    let x = source;
    while (x.parent !== lca) {
        x = x.parent!;
    }
    return x;
}

/** True if `s` is the source of at least one completion (event-less) transition. */
export function hasCompletion(m: Machine, s: MState): boolean {
    return m.transitions.some(t => t.kind === 'completion' && t.source === s);
}

/**
 * State whose completion transitions are triggered when `s` is entered as a leaf (if any).
 *
 * Two cases: a state with completion transitions of its own completes as soon as it has been entered; a
 * final state completes its parent (if the parent has completion transitions), because reaching a final
 * state finishes the parent's region. For an orthogonal parent this is only a candidate: the parent
 * completes once every region has reached a final state, which the generated MarkCompletion checks at run
 * time. A composite state can be its own owner here, but the generated code only consults this for leaves.
 * Also used by the C and C# generators.
 */
export function completionOwner(m: Machine, s: MState): MState | null {
    return hasCompletion(m, s) ? s : s.isFinal && s.parent && hasCompletion(m, s.parent) ? s.parent : null;
}

/**
 * Type in which a copy of an event parameter is stored (the C++ event queue, the C argument structs): the
 * declared type without a trailing reference (`&` or `&&`) and without a top-level `const`, so that the copy
 * outlives the call and can be assigned. A `const` that qualifies the pointee of a pointer stays, because the
 * argument could not be stored otherwise: `const std::string&` -> `std::string`, `const int` -> `int`,
 * `const char*` -> `const char*`, `char* const` -> `char*`. Template arguments are left alone. Also used by
 * the C generator.
 */
export function storageType(type: string): string {
    const t = type.trim().replace(/&+\s*$/, '');
    // `const` keywords outside template brackets are removed from `part`.
    const stripConst = (part: string) => {
        let depth = 0;
        let out = '';
        for (let i = 0; i < part.length; i++) {
            const ch = part[i];
            depth += ch === '<' ? 1 : ch === '>' ? -1 : 0;
            if (depth === 0 && /^const\b/.test(part.slice(i)) && !/[A-Za-z0-9_]/.test(part[i - 1] ?? '')) {
                i += 'const'.length - 1;
                continue;
            }
            out += ch;
        }
        return out;
    };
    // Everything after the last `*` outside template brackets qualifies the pointer itself (top level); without
    // a `*` the whole type is the top level.
    let depth = 0;
    let star = -1;
    for (let i = 0; i < t.length; i++) {
        depth += t[i] === '<' ? 1 : t[i] === '>' ? -1 : 0;
        if (t[i] === '*' && depth === 0) {
            star = i;
        }
    }
    const result = star < 0 ? stripConst(t) : t.slice(0, star + 1) + stripConst(t.slice(star + 1));
    return result.replace(/\s+/g, ' ').trim();
}

/**
 * Smallest unsigned C/C++ integer type that can hold every value from 0 to `max`; used for the region index
 * and region count columns of the table style, so that they stay compact without limiting the number of
 * regions. Also used by the C generator.
 */
export function indexType(max: number): string {
    return max <= 0xff ? 'unsigned char' : max <= 0xffff ? 'unsigned short' : 'unsigned long';
}

/**
 * Generates the complete `<Name>.hpp` header for a machine.
 *
 * The function is one long, linear emitter: the order of the statements below is the order of the
 * declarations in the generated class, so reading it top to bottom follows the header. Small local helpers
 * (closures over `m`, `w` and the feature flags) keep the repetitive parts short. The output is
 * deterministic and compared byte for byte with test/golden; any change to emitted text needs the golden
 * files to be regenerated.
 *
 * @param m analysed, error-free machine; its codegen options (trace, threadSafe, queue) are honoured.
 * @param style 'switch' for nested switch statements, 'table' for constant transition tables.
 * @returns the header text with LF line endings.
 */
export function generateCpp(m: Machine, style: Style): string {
    // K&R braces, four-space indentation.
    const w = new Writer(false);
    const cls = m.name;
    const table = style === 'table';
    // C++ spelling of a state (null/undefined -> State::None, e.g. the parent of a top-level state).
    const st = (s: MState | null | undefined) => `State::${s ? s.name : 'None'}`;
    const ev = (e: string) => `Event::${e}`;
    // Feature flags derived from the diagram; each one switches a group of members on or off.
    const topFinals = m.states.filter(s => s.isFinal && !s.parent);
    const paramEvents = m.events.filter(e => (m.params.get(e) ?? []).length > 0);
    const hasArgs = paramEvents.length > 0;
    const historyStates = m.states.filter(s => s.history);
    const hasHistory = historyStates.length > 0;
    const hasInternal = m.transitions.some(t => t.internal);
    // Transitions that lead into a choice point; each becomes a Fire_<index> member function.
    const compound = m.transitions.filter(t => t.branches);
    const hasTimers = m.timers.length > 0;
    const orthogonal = m.states.some(s => s.regions.length > 1);
    // Events the untyped Dispatch/Post refuse: events with parameters (their arguments could not be
    // supplied, so the typed Dispatch<E>/Post<E> must be used) and the internal Completion event.
    const rejected = [...paramEvents, ...(m.completion ? [COMPLETION_EVENT] : [])];

    // Parameter list of a guard/action hook declaration, e.g. `int cents` (empty for parameterless hooks).
    const paramDecls = (hook: string) => (m.hookParams.get(hook) ?? []).map(p => p.decl).join(', ');
    // Arguments passed to a hook triggered by event `e`: read back from the event's argument struct, e.g.
    // `ArgsOfCoin().cents`. Events without parameters give an empty list.
    const callArgs = (e: string) => (m.params.get(e) ?? []).map(p => `ArgsOf${e}().${p.name}`).join(', ');
    const call = (hook: string, e?: string) => `${hook}(${e ? callArgs(e) : ''})`;
    // Guard test as a C++ expression, with `!` for negated guards (`!isBusy`).
    const guardCall = (t: { guard?: { name: string; negate: boolean } }, e: string) => `${t.guard!.negate ? '!' : ''}${call(t.guard!.name, e)}`;
    // Trace name of a transition as a C++ string literal: "S -> T", "S -> T (history)" or "S (internal)".
    const transitionName = (t: MTransition) =>
        `"${t.source.name}${t.internal ? ' (internal)' : ` -> ${t.target.name}${t.history ? ' (history)' : ''}`}"`;
    // Name of the member function that performs a compound (choice point) transition; the index is the
    // transition's position in m.transitions, which is also used for the table-style wrapper names.
    const fireName = (t: MTransition) => `Fire_${m.transitions.indexOf(t)}`;
    // Call of EnterDown. Its third parameter (enter the target through its history pseudostate) only exists
    // when the diagram has history pseudostates.
    const enterDown = (from: string, target: string, history: string) => `EnterDown(${from}, ${target}${hasHistory ? `, ${history}` : ''})`;

    // Table style: every table cell is a single member pointer, so composite calls become private wrappers.
    // `wrappers` collects them while the table rows are built and is emitted later as private methods.
    const wrappers: { signature: string; body: string[] }[] = [];
    /**
     * Handler cell (a parameterless member pointer) for a list of action hooks: `nullptr` when there is
     * nothing to do, a direct `&Class::hook` for exactly one hook that takes no event arguments, otherwise
     * `&Class::<wrapperName>` for a newly registered wrapper method that makes all the calls in order
     * (passing the arguments of event `e`, if given).
     */
    const handler = (actions: string[], wrapperName: string, e?: string): string => {
        if (actions.length === 0) {
            return 'nullptr';
        }
        if (actions.length === 1 && !(e && callArgs(e))) {
            return `&${cls}::${actions[0]}`;
        }
        wrappers.push({ signature: `void ${wrapperName}()`, body: actions.map(a => `${call(a, e)};`) });
        return `&${cls}::${wrapperName}`;
    };
    /** First statement of every public non-static member when thread safety is enabled: an RAII lock. */
    const guard = () => {
        if (m.threadSafe) {
            w.line('const ScopedLock lock(*this);');
        }
    };
    /**
     * Emits `switch (subject) { case ...: lines... default: defaultLines }`.
     *
     * Every switch gets a `default:` so that compilers do not warn about unhandled enumerators. When there
     * are no cases at all no switch is emitted: the parameters listed in `unused` are cast to void (to avoid
     * unused-parameter warnings) and the default lines are emitted directly, minus a `break;` that would be
     * illegal outside a switch.
     */
    const switchOn = (subject: string, cases: { labels: string[]; lines: string[] }[], defaultLines: string[], unused: string[] = []) => {
        if (cases.length === 0) {
            unused.forEach(u => w.line(`(void)${u};`));
            defaultLines.filter(l => l !== 'break;').forEach(l => w.line(l));
            return;
        }
        w.open(`switch (${subject})`);
        for (const c of cases) {
            c.labels.forEach(l => w.line(`case ${l}:`));
            w.indent();
            c.lines.forEach(l => w.line(l));
            w.dedent();
        }
        w.line('default:');
        w.indent();
        defaultLines.forEach(l => w.line(l));
        w.dedent();
        w.close();
    };
    /** Emits an in-class member function definition followed by a blank line. */
    const method = (signature: string, body: () => void) => {
        w.open(signature);
        body();
        w.close();
        w.line('');
    };

    // ---------------------------------------------------------------- file header and public enumerations
    w.line(`// ${cls}: ${style}-based hierarchical state machine generated by MachinaState.`);
    w.line('// Do not edit by hand. Derive from this class and implement the guard and action hooks.');
    w.line('#pragma once');
    w.line('');
    w.line('#include <cstddef>');
    w.line('');
    // Diagram namespaces are written with dots (or ::); C++17 nested namespace definitions accept `A::B`.
    if (m.namespace) {
        w.open(`namespace ${m.namespace.replace(/\./g, '::')}`);
        w.line('');
    }

    w.open(`class ${cls}`);
    w.label('public:');
    // States in pre-order, so the enumerator value doubles as the index into the per-state tables and the
    // pending_ flags. None is last: it is not a real state and has no table entries.
    w.open('enum class State');
    for (const s of m.states) {
        w.line(`${s.name},${s.parent ? `   // in ${s.parent.name}` : ''}`);
    }
    w.line('None');
    w.close('};');
    w.line('');
    // Events: user events, then one generated event per distinct timeout, then Completion (if used).
    // Timeout and completion enumerators are annotated so users can tell them apart from their own events.
    w.open('enum class Event');
    m.events.forEach((e, i) => {
        const timer = m.timers.find(x => x.event === e);
        const note = timer ? `   // after(${timer.milliseconds} ms) in ${timer.state.name}` : e === COMPLETION_EVENT && m.completion ? '   // internal: completion of a state' : '';
        w.line(`${e}${i < m.events.length - 1 ? ',' : ''}${note}`);
    });
    w.close('};');
    w.line('');
    if (m.trace) {
        w.open('enum class TraceKind');
        w.line('Start,        // name = machine name');
        w.line('Event,        // name = event being dispatched');
        w.line('Ignored,      // name = event no state handled');
        w.line('Transition,   // name = "Source -> Target"');
        w.line('Exit,         // name = state being exited');
        w.line('Enter         // name = state being entered');
        w.close('};');
        w.line('');
    }
    // Sizes of the per-state, per-event, per-region and per-timer arrays.
    w.line(`static constexpr std::size_t kStateCount  = ${m.states.length};`);
    w.line(`static constexpr std::size_t kEventCount  = ${m.events.length};`);
    w.line(`static constexpr std::size_t kRegionCount = ${m.regions.length};   // region 0 is the top level`);
    if (hasTimers) {
        w.line(`static constexpr std::size_t kTimerCount  = ${m.timers.length};`);
    }
    if (m.queue) {
        w.line(`static constexpr std::size_t kQueueCapacity = ${m.queueCapacity};`);
    }
    w.line('');
    // The class is meant to be derived from (the hooks are pure virtual), hence the virtual destructor.
    w.line(`virtual ~${cls}() = default;`);
    w.line('');

    // ---------------------------------------------------------------- public API
    // Start(): a full reset of the run-time state, then the top-level initial transition and the entry of its
    // target (which recursively follows initial transitions down to the leaves), then run to completion like
    // a dispatch. The reset cancels every armed timer (CancelTimer, and a new generation so that a timeout
    // still on its way is stale) and clears the configuration, the history, the completion flags and the
    // queue. It is a reset, not a transition: the states active before are not exited (no exit actions).
    w.line('// Resets the machine (running timers are cancelled, history is forgotten) and enters the initial state configuration.');
    method('void Start()', () => {
        guard();
        if (hasTimers) {
            if (table) {
                w.open('for (std::size_t i = 0; i < kTimerCount; ++i)');
                w.open('if (timerArmed_[i])');
                w.line('timerArmed_[i] = false;');
                w.line('++timerGeneration_[i];');
                w.line('CancelTimer(kTimers[i].event);');
                w.close();
                w.close();
            } else {
                for (const x of m.timers) {
                    w.open(`if (timerArmed_[${x.index}])`);
                    w.line(`timerArmed_[${x.index}] = false;`);
                    w.line(`++timerGeneration_[${x.index}];`);
                    w.line(`CancelTimer(${ev(x.event)});`);
                    w.close();
                }
            }
        }
        w.open('for (State& state : active_)');
        w.line('state = State::None;');
        w.close();
        if (hasHistory) {
            w.open('for (State& state : history_)');
            w.line('state = State::None;');
            w.close();
        }
        if (m.completion) {
            w.open('for (bool& flag : pending_)');
            w.line('flag = false;');
            w.close();
        }
        if (m.queue) {
            w.line('queueHead_  = 0;');
            w.line('queueCount_ = 0;');
        }
        if (m.trace) {
            w.line(`Trace(TraceKind::Start, "${cls}");`);
        }
        // Actions of the top-level initial transition run before anything is entered.
        m.initial.actions.forEach(a => w.line(`${a}();`));
        w.line(`${enterDown('State::None', st(m.initial.target), 'false')};`);
        // Entering may have marked states as completed (e.g. an initialisation state with an event-less
        // transition), and entry actions may have posted events; both are processed before Start returns.
        if (m.completion) {
            w.line('RunCompletions();');
        }
        if (m.queue) {
            w.line('DrainQueue();');
        }
    });

    /**
     * Common tail of the public dispatch methods: run the event through DispatchCore, invalidate the argument
     * pointer (it points to a local of the caller, see Dispatch<E>), process queued events, and report
     * whether the original event was handled (queued events do not affect the result).
     */
    const finishPublicDispatch = (dispatch: string) => {
        w.line(`const bool handled = ${dispatch};`);
        if (hasArgs) {
            w.line('args_ = nullptr;');
        }
        if (m.queue) {
            w.line('DrainQueue();');
        }
        w.line('return handled;');
    };

    // Dispatch(Event): the untyped entry point. Events with parameters and the internal Completion event are
    // refused with `false`; their arguments could not be supplied here. args_ is cleared first so a hook can
    // never read stale arguments.
    w.line('// Dispatches an event to the innermost active states first. Returns false if the event was not handled.');
    method('bool Dispatch(Event event)', () => {
        guard();
        if (rejected.length) {
            switchOn('event', [{ labels: rejected.map(ev), lines: ['return false;   // use the typed Dispatch method / internal event'] }], ['break;']);
        }
        if (hasArgs) {
            w.line('args_ = nullptr;');
        }
        finishPublicDispatch('DispatchCore(event)');
    });
    // Dispatch<E>(params...): one typed method per event with parameters. The arguments are bundled in a
    // stack-allocated <E>Args struct and published through the type-erased args_ pointer for the duration of
    // the call; hooks read them back with ArgsOf<E>(). Reference parameters are therefore never copied.
    for (const e of paramEvents) {
        const ps = m.params.get(e)!;
        method(`bool Dispatch${e}(${ps.map(p => p.decl).join(', ')})`, () => {
            guard();
            w.line(`const ${e}Args args { ${ps.map(p => p.name).join(', ')} };`);
            w.line('args_ = &args;');
            finishPublicDispatch(`DispatchCore(${ev(e)})`);
        });
    }
    // DispatchTimeout: the entry point for elapsed timers. A timeout is only dispatched if its timer is
    // still armed and the generation matches the one passed to StartTimer; a timer that was cancelled, or
    // restarted by re-entering its state, is ignored, so a late callback cannot cut a new wait short. Timers
    // are one-shot: DispatchCore disarms the timer of a dispatched timeout, so calling DispatchTimeout again
    // with the same generation is ignored even if the timeout's guard was false or its transition internal.
    // Calling Dispatch(timeout) directly is also possible (to drive timeouts by hand); it skips the generation
    // check but disarms the timer just the same.
    if (hasTimers) {
        w.line('// Dispatches a timeout reported by a timer started with StartTimer; stale timeouts are ignored.');
        method('bool DispatchTimeout(Event timeout, unsigned generation)', () => {
            guard();
            w.line('const int index = TimerIndex(timeout);');
            w.open('if (index < 0 || !timerArmed_[index] || timerGeneration_[index] != generation)');
            w.line('return false;');
            w.close();
            if (hasArgs) {
                w.line('args_ = nullptr;');
            }
            finishPublicDispatch('DispatchCore(timeout)');
        });
    }

    // Read-only queries. Because every region has its own slot in active_, IsIn works for states at any
    // depth and in any region (including ancestors of the active leaves) with a single comparison.
    w.line('// Innermost active state (following the first region of orthogonal states).');
    method('State Current() const', () => {
        guard();
        w.line('return Innermost(active_[0]);');
    });
    w.line('// True if the given state is active.');
    method('bool IsIn(State state) const', () => {
        guard();
        w.line('return state != State::None && active_[RegionOf(state)] == state;');
    });
    // Only top-level final states finish the machine; a final state inside a composite is an ordinary leaf.
    w.line('// True once a top-level final state has been reached.');
    method('bool IsFinished() const', () => {
        guard();
        w.line(`return ${topFinals.length ? topFinals.map(s => `active_[0] == ${st(s)}`).join(' || ') : 'false'};`);
    });

    // Static hierarchy and name queries (no lock needed: they only read constant data). The switch style
    // groups all children of one parent under one return; states without a parent fall to the default.
    method('static State ParentOf(State state)', () => {
        if (table) {
            w.line('return state == State::None ? State::None : kParent[Index(state)];');
        } else {
            switchOn(
                'state',
                m.states.filter(s => s.children.length > 0).map(p => ({ labels: p.children.map(st), lines: [`return ${st(p)};`] })),
                ['return State::None;'],
                ['state']
            );
        }
    });
    method('static const char* StateName(State state)', () => {
        if (table) {
            w.line('return state == State::None ? "None" : kStateNames[Index(state)];');
        } else {
            switchOn('state', m.states.map(s => ({ labels: [st(s)], lines: [`return "${s.name}";`] })), ['return "None";']);
        }
    });
    // EventName is written by hand rather than with method() because a machine without events needs a
    // special body: there is no Event enumerator to switch on and no kEventNames table to index.
    w.open('static const char* EventName(Event event)');
    if (m.events.length === 0) {
        w.line('(void)event;');
        w.line('return "";');
    } else if (table) {
        w.line('return kEventNames[static_cast<std::size_t>(event)];');
    } else {
        switchOn('event', m.events.map(e => ({ labels: [ev(e)], lines: [`return "${e}";`] })), ['return "";']);
    }
    w.close();

    // ---------------------------------------------------------------- protected: hooks for the derived class
    w.line('');
    w.label('protected:');
    if (m.threadSafe) {
        w.line('// Mutual exclusion around every public member, e.g. backed by a mutable std::mutex.');
        w.line('// Hooks must not call public members of this class unless the lock is recursive.');
        w.line('virtual void Lock() const   = 0;');
        w.line('virtual void Unlock() const = 0;');
    }
    if (hasTimers) {
        w.line('// Timers for after(...) transitions: when a timer elapses, call DispatchTimeout(timeout, generation).');
        w.line('virtual void StartTimer(Event timeout, unsigned milliseconds, unsigned generation) = 0;');
        w.line('virtual void CancelTimer(Event timeout)                                            = 0;');
    }
    if (m.trace) {
        w.line('// Override to log state machine activity.');
        w.open('virtual void Trace(TraceKind kind, const char* name)');
        w.line('(void)kind;');
        w.line('(void)name;');
        w.close();
    }
    // Post / Post<E>: queue an event from inside a hook (calling Dispatch from a hook is not allowed, the
    // machine is in the middle of a transition). They do not lock: they are meant to be called from hooks,
    // which already run under the lock. Post refuses the same events as Dispatch. Post<E> copies the
    // arguments into the queue entry by value.
    if (m.queue) {
        w.line('// Queues an event from inside a hook; it is processed after the current event. Returns false if the queue is full.');
        w.open('bool Post(Event event)');
        if (rejected.length) {
            switchOn('event', [{ labels: rejected.map(ev), lines: ['return false;'] }], ['break;']);
        }
        w.line('QueuedEvent entry {};');
        w.line('entry.event = event;');
        w.line('return Enqueue(entry);');
        w.close();
        for (const e of paramEvents) {
            const ps = m.params.get(e)!;
            w.open(`bool Post${e}(${ps.map(p => p.decl).join(', ')})`);
            w.line('QueuedEvent entry {};');
            w.line(`entry.event = ${ev(e)};`);
            ps.forEach(p => w.line(`entry.${e}_${p.name} = ${p.name};`));
            w.line('return Enqueue(entry);');
            w.close();
        }
    }
    // The user's hooks: pure virtual, with the parameters of the triggering event (if any). Guards should be
    // free of side effects; they may be evaluated without their transition firing.
    if (m.guards.length) {
        w.line('// Guards');
        m.guards.forEach(g => w.line(`virtual bool ${g}(${paramDecls(g)}) = 0;`));
    }
    if (m.actions.length) {
        w.line('// Actions');
        m.actions.forEach(a => w.line(`virtual void ${a}(${paramDecls(a)}) = 0;`));
    }

    // ---------------------------------------------------------------- private: implementation
    w.line('');
    w.label('private:');
    // RAII guard: Unlock also runs when a hook throws. Non-copyable; holds a const reference so that the
    // const query members can lock too (hence the const Lock/Unlock hooks).
    if (m.threadSafe) {
        w.open('class ScopedLock');
        w.label('public:');
        w.open(`explicit ScopedLock(const ${cls}& owner) : owner_(owner)`);
        w.line('owner_.Lock();');
        w.close();
        w.open('~ScopedLock()');
        w.line('owner_.Unlock();');
        w.close();
        w.line('ScopedLock(const ScopedLock&)            = delete;');
        w.line('ScopedLock& operator=(const ScopedLock&) = delete;');
        w.line('');
        w.label('private:');
        w.line(`const ${cls}& owner_;`);
        w.close('};');
        w.line('');
    }

    // Event arguments: one struct per event with parameters (members declared exactly as written, so
    // references stay references) and an accessor that casts the type-erased args_ pointer back. ArgsOf<E>
    // is only called from hooks of transitions triggered by E (model.ts binds hook parameters per event),
    // during which args_ points to an <E>Args.
    if (hasArgs) {
        w.line('// Arguments of the event being dispatched; only valid during Dispatch.');
        for (const e of paramEvents) {
            w.open(`struct ${e}Args`);
            m.params.get(e)!.forEach(p => w.line(`${p.decl};`));
            w.close('};');
            method(`const ${e}Args& ArgsOf${e}() const`, () => w.line(`return *static_cast<const ${e}Args*>(args_);`));
        }
        w.line('const void* args_ = nullptr;');
        w.line('');
    }

    // Event queue: a fixed-capacity ring buffer (queueHead_ = oldest entry, queueCount_ = number of entries)
    // inside the object, so no heap is used. A QueuedEvent holds the event plus a by-value copy of the
    // parameters of every event with parameters, named <Event>_<param>; only the fields of `event` are
    // meaningful. The entries are value-initialised, so parameter types must be default constructible. The
    // copies use storageType(): no reference and no top-level const (`const std::string&` is stored as a
    // `std::string`, `const int` as an `int`), but a pointer keeps the const of its pointee (`const char*`).
    if (m.queue) {
        w.open('struct QueuedEvent');
        w.line('Event event;');
        for (const e of paramEvents) {
            m.params.get(e)!.forEach(p => w.line(`${storageType(p.type)} ${e}_${p.name};`));
        }
        w.close('};');
        w.line('');
        method('bool Enqueue(const QueuedEvent& entry)', () => {
            w.open('if (queueCount_ == kQueueCapacity)');
            w.line('return false;');
            w.close();
            w.line('queue_[(queueHead_ + queueCount_) % kQueueCapacity] = entry;');
            w.line('++queueCount_;');
            w.line('return true;');
        });
        // DrainQueue: dispatches queued events in FIFO order until the queue is empty. Events posted while
        // draining are appended and processed by the same loop. The entry is copied out and dequeued before
        // it is dispatched, so its hooks can Post again without overwriting it. Events with parameters
        // rebuild their <E>Args struct from the stored copies (in a braced case scope for the local) and
        // publish it through args_ for the duration of the dispatch, exactly like Dispatch<E>.
        method('void DrainQueue()', () => {
            w.open('while (queueCount_ > 0)');
            w.line('const QueuedEvent entry = queue_[queueHead_];');
            w.line('queueHead_              = (queueHead_ + 1) % kQueueCapacity;');
            w.line('--queueCount_;');
            if (hasArgs) {
                w.open('switch (entry.event)');
                for (const e of paramEvents) {
                    w.open(`case ${ev(e)}:`);
                    w.line(`const ${e}Args args { ${m.params.get(e)!.map(p => `entry.${e}_${p.name}`).join(', ')} };`);
                    w.line('args_ = &args;');
                    w.line('DispatchCore(entry.event);');
                    w.line('args_ = nullptr;');
                    w.line('break;');
                    w.close();
                }
                w.line('default:');
                w.indent();
                w.line('DispatchCore(entry.event);');
                w.line('break;');
                w.dedent();
                w.close();
            } else {
                w.line('DispatchCore(entry.event);');
            }
            w.close();
        });
    }

    /**
     * Emits the entry part of a transition: enter from below `lca` down to `target`. For a history
     * transition `target` is the composite owning the history pseudostate, and EnterDown restores its
     * recorded configuration (EnterHistory) instead of entering it by default.
     */
    const emitEnter = (lca: MState | null, target: MState, history: boolean) => {
        w.line(`${enterDown(st(lca), st(target), history ? 'true' : 'false')};`);
    };
    // Emits the statements that perform a (non-compound) transition and return true.
    // Order (the UML order for external transitions): trace, exit everything below the LCA by exiting its
    // child on the source's path (exitRoot; innermost states first), run the transition actions, enter from
    // below the LCA down to the target. Internal transitions skip the exit and entry and only run actions.
    // The LCA is computed statically by model.ts, so no ancestor search happens at run time in this style.
    const emitTransition = (t: MTransition) => {
        if (m.trace) {
            w.line(`Trace(TraceKind::Transition, ${transitionName(t)});`);
        }
        if (!t.internal) {
            w.line(`ExitState(${st(exitRoot(t.source, t.lca))});`);
        }
        t.actions.forEach(a => w.line(`${call(a, t.event)};`));
        if (!t.internal) {
            emitEnter(t.lca, t.target, t.history);
        }
        w.line('return true;');
    };
    // Emits choice branches; every leaf performs the whole compound transition and returns true.
    //
    // Junction semantics: the branch guards are tested before anything is exited, so a transition never
    // stops half-way. Each branch path is resolved separately (its own target and LCA, computed per source
    // by model.ts), and only a leaf emits the actual transition: exit, then the actions of all segments in
    // order (`prefix` accumulates the incoming transition's and the enclosing branches' actions), then entry.
    // Branches are sorted guarded-first with at most one unguarded ([else]) branch; that one is emitted
    // without an `if` and ends the loop, because nothing after it could be reached. A guarded branch into a
    // nested choice whose own branches all fail falls through to the next sibling branch (backtracking).
    const emitBranches = (t: MTransition, branches: MBranch[], prefix: string[]) => {
        for (const b of branches) {
            if (b.guard) {
                w.open(`if (${guardCall(b, t.event)})`);
            }
            if (b.branches) {
                emitBranches(t, b.branches, [...prefix, ...b.actions]);
            } else {
                if (m.trace) {
                    w.line(`Trace(TraceKind::Transition, "${t.source.name} -> ${b.target!.name}${b.history ? ' (history)' : ''} (choice)");`);
                }
                w.line(`ExitState(${st(exitRoot(t.source, b.lca))});`);
                [...prefix, ...b.actions].forEach(a => w.line(`${call(a, t.event)};`));
                emitEnter(b.lca, b.target!, b.history);
                w.line('return true;');
            }
            if (b.guard) {
                w.close();
            } else {
                break;
            }
        }
    };

    // DispatchCore: the run-to-completion step shared by all dispatch paths (public methods and DrainQueue).
    // It offers the event to the whole active configuration starting at the top-level state; DispatchState
    // recursion makes the innermost states see it first. Completion transitions are processed only after a
    // handled event, because only a fired transition can enter states and so mark them as completed.
    // A timeout event disarms its timer first, whichever way it was dispatched (timers are one-shot), and
    // with orthogonal states exited_ is cleared for the step (see DispatchState).
    method('bool DispatchCore(Event event)', () => {
        if (hasTimers) {
            w.line('const int timer = TimerIndex(event);');
            w.open('if (timer >= 0)');
            w.line('timerArmed_[timer] = false;   // a timer fires once');
            w.close();
        }
        if (orthogonal) {
            w.line('exited_ = State::None;');
        }
        if (m.trace) {
            w.line('Trace(TraceKind::Event, EventName(event));');
        }
        w.open('if (active_[0] != State::None && DispatchState(active_[0], event))');
        if (m.completion) {
            w.line('RunCompletions();');
        }
        w.line('return true;');
        w.close();
        if (m.trace) {
            w.line('Trace(TraceKind::Ignored, EventName(event));');
        }
        w.line('return false;');
    });
    // DispatchState: the event is offered depth first to the active state of each of `state`'s regions (all
    // of them for an orthogonal state, in region order, so several regions can handle the same event in one
    // step), and to `state` itself only if no region handled it - this is how inner states take priority
    // over outer ones. If a transition taken in one region exited `state` itself, the remaining regions are
    // not asked, even when the transition re-entered `state` (its fresh regions must not see the same event
    // again). That is known from exited_, the outermost state exited by the latest transition (ExitState of
    // the exit root finishes last): `state` was exited iff exited_ is `state` or one of its ancestors. A
    // transition that exits a state makes every DispatchState level up to that state return at once, so when
    // this is checked, exited_ belongs to a transition taken in the region just asked. Without orthogonal
    // states every state has at most one region and the first handled event ends the loop.
    w.line('// Offers the event to every active region below `state` first, then to `state` itself.');
    method('bool DispatchState(State state, Event event)', () => {
        if (orthogonal) {
            w.line('bool handled = false;');
        }
        w.line('const std::size_t first = FirstRegionOf(state);');
        w.open('for (std::size_t region = first; region < first + RegionsOf(state); ++region)');
        w.open('if (active_[region] != State::None && DispatchState(active_[region], event))');
        if (orthogonal) {
            w.line('handled = true;');
            w.line('// Stop if the transition exited `state`, even if it entered it again.');
            w.open('for (State s = state; s != State::None; s = ParentOf(s))');
            w.open('if (s == exited_)');
            w.line('return true;');
            w.close();
            w.close();
        } else {
            w.line('return true;');
        }
        w.close();
        w.close();
        w.line(orthogonal ? 'return handled || HandleEvent(state, event);' : 'return HandleEvent(state, event);');
    });

    // One Fire_<i>() per transition into a choice point, shared by both styles (in the table style the row's
    // `fire` cell points to it). The transition's own guard is tested by the caller; Fire_<i> tests the
    // branch guards and performs the selected path. If the branches are not exhaustive (no [else] path) and
    // no guard holds, it returns false: the transition counts as not enabled and the event continues to the
    // next candidate transition or outer state.
    for (const t of compound) {
        w.line(`// ${t.kind === 'completion' ? 'Completion of' : `Event ${t.event} in`} ${t.source.name}: choice point.`);
        method(`bool ${fireName(t)}()`, () => {
            emitBranches(t, t.branches!, t.actions);
            if (!isExhaustive(t.branches!)) {
                w.line('return false;');
            }
        });
    }

    // Completion transitions. Entering a leaf may "complete" a state (see completionOwner); the generated
    // MarkCompletion sets that state's pending_ flag (indexed by the State value). RunCompletions then
    // repeatedly takes the pending state with the lowest index (pre-order, so outer states before inner
    // ones), clears its flag and, if the state is still active, offers it the internal Completion event.
    // Completion is offered to the owning state only (it does not bubble). Firing a completion transition
    // can enter new states and mark further completions, so the loop runs until no flag is left; a
    // completion whose guards all fail is simply discarded and the state stays active.
    if (m.completion) {
        w.line('// Completion transitions fire once a state is entered, or a composite state has reached final states in all regions.');
        method('void RunCompletions()', () => {
            w.open('for (;;)');
            w.line('std::size_t index = 0;');
            w.open('while (index < kStateCount && !pending_[index])');
            w.line('++index;');
            w.close();
            w.open('if (index == kStateCount)');
            w.line('return;');
            w.close();
            w.line('pending_[index]   = false;');
            w.line('const State state = static_cast<State>(index);');
            w.open('if (active_[RegionOf(state)] == state)');
            w.line(`HandleEvent(state, ${ev(COMPLETION_EVENT)});`);
            w.close();
            w.close();
        });
        // MarkCompletion(leaf) is called by EnterDefault and EnterHistory for every leaf that is entered. The
        // owner completes immediately if it is the leaf itself or a parent with a single region (reaching the
        // final state finishes that region); an orthogonal parent completes only once every region's active
        // state is final, which is checked at run time because the sibling regions may still be on their way.
        // The table style looks the owner up in kCompletion; the switch style hard-codes one case per leaf
        // that has an owner (composites with completion transitions of their own are never passed in).
        method('void MarkCompletion(State state)', () => {
            if (table) {
                w.line('const State owner = kCompletion[Index(state)];');
                w.open('if (owner != State::None && (owner == state || AllRegionsFinal(owner)))');
                w.line('pending_[Index(owner)] = true;');
                w.close();
            } else {
                const cases: { labels: string[]; lines: string[] }[] = [];
                for (const s of m.states.filter(x => x.regions.length === 0)) {
                    const owner = completionOwner(m, s);
                    if (!owner) {
                        continue;
                    }
                    if (owner === s || owner.regions.length === 1) {
                        cases.push({ labels: [st(s)], lines: [`pending_[${owner.index}] = true;   // ${owner.name}`, 'break;'] });
                    } else {
                        // Brace-less `if`: the body is indented by hand because these are plain case lines.
                        cases.push({
                            labels: [st(s)],
                            lines: [`if (AllRegionsFinal(${st(owner)}))`, `    pending_[${owner.index}] = true;   // ${owner.name}`, 'break;']
                        });
                    }
                }
                switchOn('state', cases, ['break;'], ['state']);
            }
        });
        // AllRegionsFinal: true if every region of `state` has a final state active. The table-style
        // MarkCompletion always references it, so without orthogonal states it gets a trivial stub there
        // (with one region, reaching a final state is enough); the switch style only calls it for
        // orthogonal owners and omits it otherwise.
        if (orthogonal) {
            method('bool AllRegionsFinal(State state) const', () => {
                w.line('const std::size_t first = FirstRegionOf(state);');
                w.open('for (std::size_t region = first; region < first + RegionsOf(state); ++region)');
                w.open('if (!IsFinalState(active_[region]))');
                w.line('return false;');
                w.close();
                w.close();
                w.line('return true;');
            });
        } else if (table) {
            method('bool AllRegionsFinal(State state) const', () => {
                w.line('(void)state;');
                w.line('return true;   // no orthogonal states');
            });
        }
    }

    // Timers for after(...) transitions. Each distinct timeout of a state is one timer with its own event,
    // generation counter and armed flag. StartTimers(state) runs after the state's entry actions and starts
    // all of its timers with a fresh generation; CancelTimers(state) runs before its exit actions. An
    // external self transition therefore restarts the timer, an internal transition does not.
    if (hasTimers) {
        /**
         * Emits `void <name>(State state)` that applies `lines` to every timer owned by `state`: a loop over
         * kTimers in the table style, a switch with one case per owning state in the switch style. `lines`
         * receives the C++ expressions for the timer index, its event and its duration.
         */
        const timerLoop = (name: string, lines: (i: string, event: string, ms: string) => string[]) => {
            method(`void ${name}(State state)`, () => {
                if (table) {
                    w.open('for (std::size_t i = 0; i < kTimerCount; ++i)');
                    w.open('if (kTimers[i].state == state)');
                    lines('i', 'kTimers[i].event', 'kTimers[i].milliseconds').forEach(l => w.line(l));
                    w.close();
                    w.close();
                } else {
                    const owners = [...new Set(m.timers.map(x => x.state))];
                    switchOn(
                        'state',
                        owners.map(s => ({
                            labels: [st(s)],
                            lines: [...m.timers.filter(x => x.state === s).flatMap(x => lines(String(x.index), ev(x.event), `${x.milliseconds}u`)), 'break;']
                        })),
                        ['break;']
                    );
                }
            });
        };
        // The generation is incremented before the hook is called, so the value passed to StartTimer is the
        // one DispatchTimeout will accept.
        timerLoop('StartTimers', (i, e, ms) => [`++timerGeneration_[${i}];`, `timerArmed_[${i}] = true;`, `StartTimer(${e}, ${ms}, timerGeneration_[${i}]);`]);
        timerLoop('CancelTimers', (i, e) => [`timerArmed_[${i}] = false;`, `CancelTimer(${e});`]);
        // Maps a timeout event to its timer index, or -1 for any other event (rejected by DispatchTimeout).
        method('static int TimerIndex(Event event)', () => {
            if (table) {
                w.open('for (std::size_t i = 0; i < kTimerCount; ++i)');
                w.open('if (kTimers[i].event == event)');
                w.line('return static_cast<int>(i);');
                w.close();
                w.close();
                w.line('return -1;');
            } else {
                switchOn('event', m.timers.map(x => ({ labels: [ev(x.event)], lines: [`return ${x.index};`] })), ['return -1;']);
            }
        });
    }

    /**
     * Emits ExitState(state), which exits `state` together with all of its active descendants.
     *
     * Order: exit the active state of each own region, last region first (recursively, so the innermost
     * states are exited first), then trace, cancel the state's timers, run its exit actions (`exitCall`,
     * which differs per style) and finally clear its slot. With history pseudostates the state is then
     * recorded as the one last exited from its region (history_), and with orthogonal states it becomes
     * exited_; the exit root's call finishes last, so exited_ ends up holding the outermost exited state.
     */
    const exitState = (exitCall: string) => {
        method('void ExitState(State state)', () => {
            w.line('const std::size_t first = FirstRegionOf(state);');
            // Counts down from the last region; `region-- > first` avoids unsigned underflow at region 0.
            w.open('for (std::size_t region = first + RegionsOf(state); region-- > first;)');
            w.open('if (active_[region] != State::None)');
            w.line('ExitState(active_[region]);');
            w.close();
            w.close();
            if (m.trace) {
                w.line('Trace(TraceKind::Exit, StateName(state));');
            }
            if (hasTimers) {
                w.line('CancelTimers(state);');
            }
            w.line(exitCall);
            w.line('active_[RegionOf(state)] = State::None;');
            if (hasHistory) {
                w.line('history_[RegionOf(state)] = state;   // last state exited from its region');
            }
            if (orthogonal) {
                w.line('exited_ = state;');
            }
        });
    };
    /**
     * Emits the entry functions, shared by both styles except for the call that runs a state's entry actions
     * (`entryCall`) and the test whether the history pseudostate of `state` is deep (`deepTest`).
     *
     * - EnterDown(from, target[, history]): enter every state strictly below `from` down to `target`,
     *   outermost first, then complete the entry of `target` by default (EnterDefault) or, for a history
     *   transition, from its recorded history (EnterHistory). It works one level at a time: walk up from
     *   `target` to the state just below `from` (`state`, and the one below it on the path, `next`), enter
     *   `state`, and recurse from there. With orthogonal states the regions of `state` are entered in order:
     *   the one containing `next` continues along the path, the others are entered by default. `from` must
     *   be a proper ancestor of `target` (or None).
     * - EnterState(state): enter one state: its slot, the trace, its entry actions and then its timers.
     * - EnterDefault(state): enter every own region of `state` through its initial transition; a leaf is
     *   reported to MarkCompletion instead, as entering it may complete a state.
     * - EnterHistory(state, deep): enter every own region of `state` with the state last exited from it
     *   (history_), followed by its default entry (shallow history) or, recursively, by its own recorded
     *   regions (deep history, which thus restores every region of nested orthogonal states). A region without
     *   a record is entered by default; a leaf may complete, as in EnterDefault.
     * - Innermost(state): follow the first region of each composite down to the active leaf (for Current()).
     */
    const enterFunctions = (entryCall: string, deepTest: string) => {
        w.line('// Enters every state from below `from` down to `target`, then follows default (initial) transitions');
        w.line(hasHistory ? '// or, with `history`, restores the configuration recorded below `target`.' : '// below `target`.');
        method(`void EnterDown(State from, State target${hasHistory ? ', bool history' : ''})`, () => {
            w.line('State state = target;');
            w.line('State next  = State::None;');
            w.open('while (ParentOf(state) != from)');
            w.line('next  = state;');
            w.line('state = ParentOf(state);');
            w.close();
            w.line('EnterState(state);');
            w.open('if (next == State::None)');
            if (hasHistory) {
                w.open('if (history)');
                w.line(`EnterHistory(state, ${deepTest});`);
                w.line('return;');
                w.close();
            }
            w.line('EnterDefault(state);');
            w.line('return;');
            w.close();
            if (orthogonal) {
                w.line('const std::size_t first = FirstRegionOf(state);');
                w.open('for (std::size_t region = first; region < first + RegionsOf(state); ++region)');
                w.open('if (region == RegionOf(next))');
                w.line(`${enterDown('state', 'target', 'history')};`);
                w.chain('else');
                w.line('EnterRegion(region);');
                w.close();
                w.close();
            } else {
                w.line(`${enterDown('state', 'target', 'history')};`);
            }
        });
        method('void EnterState(State state)', () => {
            w.line('active_[RegionOf(state)] = state;');
            if (m.trace) {
                w.line('Trace(TraceKind::Enter, StateName(state));');
            }
            w.line(entryCall);
            if (hasTimers) {
                w.line('StartTimers(state);');
            }
        });
        method('void EnterDefault(State state)', () => {
            w.line('const std::size_t first = FirstRegionOf(state);');
            w.open('for (std::size_t region = first; region < first + RegionsOf(state); ++region)');
            w.line('EnterRegion(region);');
            w.close();
            if (m.completion) {
                w.open('if (RegionsOf(state) == 0)');
                w.line('MarkCompletion(state);');
                w.close();
            }
        });
        if (hasHistory) {
            w.line('// Restores the regions of `state` from the states last exited from them (recursively for deep history).');
            method('void EnterHistory(State state, bool deep)', () => {
                w.line('const std::size_t first = FirstRegionOf(state);');
                w.open('for (std::size_t region = first; region < first + RegionsOf(state); ++region)');
                w.line('const State remembered = history_[region];');
                w.open('if (remembered == State::None)');
                w.line('EnterRegion(region);');
                w.chain('else if (deep)');
                w.line('EnterState(remembered);');
                w.line('EnterHistory(remembered, true);');
                w.chain('else');
                w.line('EnterDown(state, remembered, false);');
                w.close();
                w.close();
                if (m.completion) {
                    w.open('if (RegionsOf(state) == 0)');
                    w.line('MarkCompletion(state);');
                    w.close();
                }
            });
        }
        // Used by Current(). With an orthogonal state on the way only its first region is followed.
        method('State Innermost(State state) const', () => {
            w.open('while (state != State::None && RegionsOf(state) > 0 && active_[FirstRegionOf(state)] != State::None)');
            w.line('state = active_[FirstRegionOf(state)];');
            w.close();
            w.line('return state;');
        });
    };

    if (table) {
        // ============================================================ table style
        // Type of the region columns (kRegionOf, kFirstRegion, kRegionsOf): every value is at most the number
        // of regions.
        const regionIndex = indexType(m.regions.length);
        // Every cell that calls code is a pointer to a parameterless member function: Handler for actions
        // (returning void), GuardFn for guards and for the Fire_<i> choice functions (returning bool).
        // Pure virtual hooks can be referenced this way; the call through the pointer is still virtual.
        w.line(`using Handler = void (${cls}::*)();`);
        w.line(`using GuardFn = bool (${cls}::*)();`);
        w.line('');
        // One row per transition, in m.transitions order (by source state, conditional before
        // unconditional), which is also the order in which HandleEvent tries them. Optional columns are
        // present only when some transition needs them.
        w.open('struct TransitionRow');
        w.line('State   source;');
        w.line('Event   event;');
        w.line('GuardFn guard;');
        w.line('bool    negate;');
        w.line('Handler action;');
        w.line('State   target;   // None for internal transitions');
        w.line('State   lca;');
        if (hasHistory) {
            w.line('bool    history;  // enter target through its history');
        }
        if (compound.length) {
            w.line('GuardFn fire;     // choice point: performs the whole transition');
        }
        if (m.trace) {
            w.line('const char* name;');
        }
        w.close('};');
        w.line('');
        // One row per region: the owning state (None for the top level), the target of the region's initial
        // transition and that transition's actions.
        w.open('struct RegionRow');
        w.line('State   owner;');
        w.line('State   initial;');
        w.line('Handler action;');
        w.close('};');
        w.line('');
        if (hasTimers) {
            w.open('struct TimerRow');
            w.line('State    state;');
            w.line('Event    event;');
            w.line('unsigned milliseconds;');
            w.close('};');
            w.line('');
        }

        // Build the cell text of every table now: this registers the wrapper methods, which have to be
        // emitted (below) before the class is closed, while the tables themselves are defined after it.
        const rows = m.transitions.map((t, i) => {
            // A guard that receives event arguments cannot be a GuardFn cell; it is called through a
            // Guard_<i> wrapper. Negation is not part of the wrapper - it is the row's `negate` column.
            let guardRef = 'nullptr';
            if (t.guard) {
                if (callArgs(t.event)) {
                    wrappers.push({ signature: `bool Guard_${i}()`, body: [`return ${call(t.guard.name, t.event)};`] });
                    guardRef = `&${cls}::Guard_${i}`;
                } else {
                    guardRef = `&${cls}::${t.guard.name}`;
                }
            }
            // Compound rows leave action, target, lca and trace name empty: their Fire_<i> function does all
            // the work, including the trace of the branch actually taken.
            const cells = [
                st(t.source),
                ev(t.event),
                guardRef,
                t.guard?.negate ? 'true' : 'false',
                t.branches ? 'nullptr' : handler(t.actions, `Transition_${i}`, t.event),
                t.internal || t.branches ? 'State::None' : st(t.target),
                st(t.lca)
            ];
            if (hasHistory) {
                cells.push(t.history ? 'true' : 'false');
            }
            if (compound.length) {
                cells.push(t.branches ? `&${cls}::${fireName(t)}` : 'nullptr');
            }
            if (m.trace) {
                cells.push(t.branches ? 'nullptr' : transitionName(t));
            }
            return `{ ${cells.join(', ')} }`;
        });
        const entries = m.states.map(s => handler(s.entry, `Entry_${s.name}`));
        const exits = m.states.map(s => handler(s.exit, `Exit_${s.name}`));
        // Region 0 (the top level) never goes through EnterRegion - Start runs the top-level initial
        // transition itself - so its action cell stays empty.
        const regionRows = m.regions.map(r =>
            r.owner ? `{ ${st(r.owner)}, ${st(r.initial!.target)}, ${handler(r.initial!.actions, `Init_${r.index}`)} }` : `{ State::None, ${st(r.initial!.target)}, nullptr }`
        );

        // Declarations of the constant tables; the definitions follow the class (they need the complete type).
        // The region columns use the smallest unsigned type that holds every region index and count.
        w.line('static const State   kParent[kStateCount];');
        w.line('static const Handler kEntry[kStateCount];');
        w.line('static const Handler kExit[kStateCount];');
        w.line('static const char* const kStateNames[kStateCount];');
        w.line(`static const ${regionIndex} kRegionOf[kStateCount];     // region that contains the state`);
        w.line(`static const ${regionIndex} kFirstRegion[kStateCount];  // first own region`);
        w.line(`static const ${regionIndex} kRegionsOf[kStateCount];    // number of own regions`);
        w.line('static const bool    kIsFinal[kStateCount];');
        w.line('static const RegionRow kRegions[kRegionCount];');
        if (m.events.length) {
            w.line('static const char* const kEventNames[kEventCount];');
        }
        if (hasHistory) {
            w.line('static const unsigned char kHistoryKind[kStateCount];   // 0 = none, 1 = shallow, 2 = deep');
        }
        if (m.completion) {
            w.line('static const State   kCompletion[kStateCount];   // state whose completion transitions fire when this state is reached');
        }
        if (hasTimers) {
            w.line('static const TimerRow kTimers[kTimerCount];');
        }
        if (rows.length) {
            w.line(`static const TransitionRow kTransitions[${rows.length}];`);
        }
        w.line('');
        // Table accessors. They expect a real state (not None), except IsFinalState, which is also called on
        // empty region slots.
        method('static std::size_t Index(State state)', () => w.line('return static_cast<std::size_t>(state);'));
        method('static std::size_t RegionOf(State state)', () => w.line('return kRegionOf[Index(state)];'));
        method('static std::size_t FirstRegionOf(State state)', () => w.line('return kFirstRegion[Index(state)];'));
        method('static std::size_t RegionsOf(State state)', () => w.line('return kRegionsOf[Index(state)];'));
        method('static bool IsFinalState(State state)', () => w.line('return state != State::None && kIsFinal[Index(state)];'));
        // Calls a Handler cell; empty cells (nullptr) do nothing.
        method('void Invoke(Handler handler)', () => {
            w.open('if (handler != nullptr)');
            w.line('(this->*handler)();');
            w.close();
        });
        // The wrapper methods registered while the cells were built (Guard_/Transition_/Entry_/Exit_/Init_).
        for (const wr of wrappers) {
            method(wr.signature, () => wr.body.forEach(l => w.line(l)));
        }
        // HandleEvent: linear scan of the whole transition table for rows of this state and event; the first
        // row that fires wins. Rows are in priority order, so this matches the switch style.
        method('bool HandleEvent(State state, Event event)', () => {
            if (rows.length === 0) {
                w.line('(void)state;');
                w.line('(void)event;');
                w.line('return false;');
                return;
            }
            w.open('for (const TransitionRow& row : kTransitions)');
            w.open('if (row.source == state && row.event == event && TryRow(row))');
            w.line('return true;');
            w.close();
            w.close();
            w.line('return false;');
        });
        // TryRow: the table interpreter for one transition. Same sequence as the switch style's inline code:
        // guard (skip the row when the result equals `negate`, i.e. a plain guard returned false or a negated
        // one returned true), then either the choice function (which traces and performs its own path), an
        // internal transition (action only), or an external one: find the exit root by walking up from the
        // source to the child of the LCA, exit it, run the action, enter the target (or its remembered
        // history state).
        if (rows.length) {
            method('bool TryRow(const TransitionRow& row)', () => {
                w.open('if (row.guard != nullptr && (this->*row.guard)() == row.negate)');
                w.line('return false;');
                w.close();
                if (compound.length) {
                    w.open('if (row.fire != nullptr)');
                    w.line('return (this->*row.fire)();');
                    w.close();
                }
                if (m.trace) {
                    w.line('Trace(TraceKind::Transition, row.name);');
                }
                if (hasInternal) {
                    w.open('if (row.target == State::None)');
                    w.line('Invoke(row.action);');
                    w.line('return true;');
                    w.close();
                }
                w.line('State root = row.source;');
                w.open('while (ParentOf(root) != row.lca)');
                w.line('root = ParentOf(root);');
                w.close();
                w.line('ExitState(root);');
                w.line('Invoke(row.action);');
                w.line(`${enterDown('row.lca', 'row.target', 'row.history')};`);
                w.line('return true;');
            });
        }
        // Default entry of a region: run its initial transition's actions, then enter the initial target
        // (which may be nested deeper inside the region) below the owner.
        method('void EnterRegion(std::size_t region)', () => {
            w.line('Invoke(kRegions[region].action);');
            w.line(`${enterDown('kRegions[region].owner', 'kRegions[region].initial', 'false')};`);
        });
        exitState('Invoke(kExit[Index(state)]);');
        // kHistoryKind tells EnterDown whether the history pseudostate of a history transition's target is deep.
        enterFunctions('Invoke(kEntry[Index(state)]);', 'kHistoryKind[Index(state)] == 2');

        writeActive();
        writeMembers();
        w.close('};');
        w.line('');

        // Out-of-class definitions of the tables. `inline` variables (C++17) let the header be included in
        // several translation units without duplicate definitions. Each table has one entry per state (in
        // State order), region, event, timer or transition; trailing commas are valid in initialiser lists.
        /** Emits `inline <decl> = { values..., };` followed by a blank line. */
        const def = (decl: string, values: string[]) => {
            w.open(`inline ${decl} =`);
            values.forEach(v => w.line(`${v},`));
            w.close('};');
            w.line('');
        };
        def(`const ${cls}::State ${cls}::kParent[${cls}::kStateCount]`, m.states.map(s => st(s.parent)));
        def(`const ${cls}::Handler ${cls}::kEntry[${cls}::kStateCount]`, entries);
        def(`const ${cls}::Handler ${cls}::kExit[${cls}::kStateCount]`, exits);
        def(`const char* const ${cls}::kStateNames[${cls}::kStateCount]`, m.states.map(s => `"${s.name}"`));
        def(`const ${regionIndex} ${cls}::kRegionOf[${cls}::kStateCount]`, m.states.map(s => String(s.region.index)));
        // Simple states have no own region: first region 0 with a count of 0, so region loops do nothing.
        def(`const ${regionIndex} ${cls}::kFirstRegion[${cls}::kStateCount]`, m.states.map(s => String(s.regions[0]?.index ?? 0)));
        def(`const ${regionIndex} ${cls}::kRegionsOf[${cls}::kStateCount]`, m.states.map(s => String(s.regions.length)));
        def(`const bool ${cls}::kIsFinal[${cls}::kStateCount]`, m.states.map(s => (s.isFinal ? 'true' : 'false')));
        w.line('// owner, initial target, initial action');
        def(`const ${cls}::RegionRow ${cls}::kRegions[${cls}::kRegionCount]`, regionRows);
        if (m.events.length) {
            def(`const char* const ${cls}::kEventNames[${cls}::kEventCount]`, m.events.map(e => `"${e}"`));
        }
        if (hasHistory) {
            def(`const unsigned char ${cls}::kHistoryKind[${cls}::kStateCount]`, m.states.map(s => (s.history === 'deep' ? '2' : s.history ? '1' : '0')));
        }
        if (m.completion) {
            def(`const ${cls}::State ${cls}::kCompletion[${cls}::kStateCount]`, m.states.map(s => st(completionOwner(m, s))));
        }
        if (hasTimers) {
            w.line('// state, timeout event, milliseconds');
            def(`const ${cls}::TimerRow ${cls}::kTimers[${cls}::kTimerCount]`, m.timers.map(x => `{ ${st(x.state)}, ${ev(x.event)}, ${x.milliseconds}u }`));
        }
        // The transition table is preceded by a comment naming its columns, matching the optional columns of
        // TransitionRow.
        if (rows.length) {
            const columns = ['source', 'event', 'guard', 'negate guard', 'action', 'target', 'least common ancestor'];
            if (hasHistory) {
                columns.push('history');
            }
            if (compound.length) {
                columns.push('choice');
            }
            if (m.trace) {
                columns.push('trace name');
            }
            w.line(`// ${columns.join(', ')}`);
            def(`const ${cls}::TransitionRow ${cls}::kTransitions[${rows.length}]`, rows);
        }
    } else {
        // ============================================================ switch style
        // HandleEvent: `switch (state)` over the states that are the source of a transition, each with a
        // nested `switch (event)` whose cases contain the transitions of that state for that event, in
        // priority order. Each transition is emitted inline: an optional guard `if`, then either the full
        // transition code (emitTransition) or a call of its choice function. Every path that fires returns
        // true; a case falls through to `break` (and HandleEvent to `return false`) only if nothing fired.
        method('bool HandleEvent(State state, Event event)', () => {
            const sources = m.states.filter(s => m.transitions.some(t => t.source === s));
            if (sources.length === 0) {
                w.line('(void)state;');
                w.line('(void)event;');
                w.line('return false;');
                return;
            }
            w.open('switch (state)');
            for (const s of sources) {
                w.line(`case ${st(s)}:`);
                w.indent();
                w.open('switch (event)');
                const own = m.transitions.filter(t => t.source === s);
                // Cases follow the Event enumeration order; within one event, m.transitions order (transitions
                // that may not fire before the one that always fires).
                for (const e of m.events.filter(e => own.some(t => t.event === e))) {
                    w.line(`case ${ev(e)}:`);
                    w.indent();
                    let fires = false;
                    for (const t of own.filter(t => t.event === e)) {
                        if (t.guard) {
                            w.open(`if (${guardCall(t, e)})`);
                        }
                        if (t.branches) {
                            // An exhaustive choice always fires and can return its result directly; otherwise
                            // a false result falls through to the next candidate.
                            if (alwaysFires(t)) {
                                w.line(`return ${fireName(t)}();`);
                            } else {
                                w.open(`if (${fireName(t)}())`);
                                w.line('return true;');
                                w.close();
                            }
                        } else {
                            emitTransition(t);
                        }
                        if (t.guard) {
                            w.close();
                        }
                        // A transition that always fires ends the case: anything after it would be
                        // unreachable (model.ts rejects a second unconditional transition anyway), and so
                        // would the `break`, which is therefore omitted.
                        if (alwaysFires(t)) {
                            fires = true;
                            break;
                        }
                    }
                    if (!fires) {
                        w.line('break;');
                    }
                    w.dedent();
                }
                w.line('default:');
                w.indent();
                w.line('break;');
                w.dedent();
                w.close();
                w.line('break;');
                w.dedent();
            }
            w.line('default:');
            w.indent();
            w.line('break;');
            w.dedent();
            w.close();
            w.line('return false;');
        });

        // Region queries as switches: states are grouped by the region that contains them; region 0 (the top
        // level) is the default and needs no case. Simple states have no own regions (first 0, count 0).
        const byRegion = new Map<number, MState[]>();
        m.states.forEach(s => byRegion.set(s.region.index, [...(byRegion.get(s.region.index) ?? []), s]));
        method('static std::size_t RegionOf(State state)', () =>
            switchOn('state', [...byRegion].filter(([r]) => r !== 0).map(([r, list]) => ({ labels: list.map(st), lines: [`return ${r};`] })), ['return 0;'], ['state'])
        );
        const composites = m.states.filter(s => s.regions.length > 0);
        method('static std::size_t FirstRegionOf(State state)', () =>
            switchOn('state', composites.map(s => ({ labels: [st(s)], lines: [`return ${s.regions[0].index};`] })), ['return 0;'], ['state'])
        );
        // Composites grouped by their number of regions.
        const counts = new Map<number, MState[]>();
        composites.forEach(s => counts.set(s.regions.length, [...(counts.get(s.regions.length) ?? []), s]));
        method('static std::size_t RegionsOf(State state)', () =>
            switchOn('state', [...counts].map(([n, list]) => ({ labels: list.map(st), lines: [`return ${n};`] })), ['return 0;'], ['state'])
        );
        // Only AllRegionsFinal needs IsFinalState, and it only exists with orthogonal states and completions.
        if (orthogonal && m.completion) {
            const finals = m.states.filter(s => s.isFinal);
            method('static bool IsFinalState(State state)', () =>
                switchOn('state', finals.length ? [{ labels: finals.map(st), lines: ['return true;'] }] : [], ['return false;'], ['state'])
            );
        }
        // EnterRegion: default entry of a region - its initial transition's actions, then its initial target
        // entered below the owner. The top-level region is entered by Start and has no case.
        const regionCase = (r: MRegion) => ({
            labels: [String(r.index)],
            lines: [...r.initial!.actions.map(a => `${a}();`), `${enterDown(st(r.owner), st(r.initial!.target), 'false')};`, 'break;']
        });
        method('void EnterRegion(std::size_t region)', () => switchOn('region', m.regions.filter(r => r.owner).map(regionCase), ['break;'], ['region']));
        // Entry and exit actions per state; states without actions fall to the default.
        method('void OnEntry(State state)', () =>
            switchOn('state', m.states.filter(s => s.entry.length).map(s => ({ labels: [st(s)], lines: [...s.entry.map(a => `${a}();`), 'break;'] })), ['break;'], ['state'])
        );
        method('void OnExit(State state)', () =>
            switchOn('state', m.states.filter(s => s.exit.length).map(s => ({ labels: [st(s)], lines: [...s.exit.map(a => `${a}();`), 'break;'] })), ['break;'], ['state'])
        );
        // Whether the history pseudostate of a history transition's target is deep: a constant when all history
        // pseudostates are of one kind, otherwise IsDeepHistory, a switch over the deep ones.
        const deep = historyStates.filter(s => s.history === 'deep');
        if (deep.length > 0 && deep.length < historyStates.length) {
            method('static bool IsDeepHistory(State state)', () =>
                switchOn('state', [{ labels: deep.map(st), lines: ['return true;'] }], ['return false;'])
            );
        }
        exitState('OnExit(state);');
        enterFunctions('OnEntry(state);', deep.length === 0 ? 'false' : deep.length === historyStates.length ? 'true' : 'IsDeepHistory(state)');

        writeActive();
        writeMembers();
        w.close('};');
    }

    // Closes the namespace opened at the top.
    if (m.namespace) {
        w.close();
    }
    return w.toString();

    /** Emits the active configuration: one slot per region, all empty until Start() is called. */
    function writeActive(): void {
        w.line(`State active_[kRegionCount] = { ${m.regions.map(() => 'State::None').join(', ')} };   // active state per region`);
    }

    /**
     * Emits the remaining run-time data members (all zero/None-initialised): the history slots (the state
     * last exited from each region), the outermost state exited by the latest transition (exited_),
     * completion flags indexed by State, the timer generation counters and armed flags, and the event ring
     * buffer with its head and count. Start() resets all of them except the timer generations, which only
     * ever increase.
     */
    function writeMembers(): void {
        if (hasHistory) {
            w.line(`State history_[kRegionCount] = { ${m.regions.map(() => 'State::None').join(', ')} };   // state last exited per region`);
        }
        if (orthogonal) {
            w.line('State exited_ = State::None;   // outermost state exited by the latest transition');
        }
        if (m.completion) {
            w.line('bool pending_[kStateCount] = {};   // completion events not yet processed');
        }
        if (hasTimers) {
            w.line('unsigned timerGeneration_[kTimerCount] = {};');
            w.line('bool timerArmed_[kTimerCount] = {};');
        }
        if (m.queue) {
            w.line('QueuedEvent queue_[kQueueCapacity] = {};');
            w.line('std::size_t queueHead_  = 0;');
            w.line('std::size_t queueCount_ = 0;');
        }
    }
}
