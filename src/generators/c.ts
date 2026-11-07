// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// C (C99) code generator.
//
// Turns an analysed Machine (see model.ts) into two files, `<Name>.h` and `<Name>.c` (generators/index.ts picks
// the extensions; the base name is the machine name). The generated code uses only <stdbool.h> and <stddef.h>,
// never allocates memory and compiles cleanly with `-std=c99 -Wall -Wextra -Werror -pedantic`. Its behaviour is
// identical to the C++ and C# generators and to the reference interpreter in engine.ts: the test suite runs all
// of them on the same scenarios and compares the traces, and test/golden/*.h|.c pin the exact text produced here.
//
// NAMING
// Every public identifier starts with the prefix returned by cPrefix(), the namespace (with `::` and `.` turned
// into `_`) joined with the machine name, e.g. `Demo_TrafficLight`; below it is written <P>. States become
// `<P>_State_<Name>` in pre-order (parents before children), followed by the sentinel `<P>_State_None`, whose
// value therefore equals `<P>_StateCount`; events become `<P>_Event_<Name>`. Functions inside the .c file are
// `static` and keep short unprefixed names (RegionOf, ExitState, ...), which model.ts reserves so that user hooks
// cannot clash with them.
//
// HEADER (<P>.h), in this order:
//
//   typedef enum { <P>_State_A, <P>_State_B /* in A */, ..., <P>_State_None } <P>_State;
//   typedef enum { user events..., timeout events..., <P>_Event_Completion } <P>_Event;
//   typedef enum { <P>_Trace_Start, _Event, _Ignored, _Transition, _Exit, _Enter } <P>_TraceKind;  [trace]
//   enum { <P>_StateCount, <P>_EventCount, <P>_RegionCount, <P>_TimerCount [timers], <P>_QueueCapacity [queue] };
//   typedef struct {                                     everything the application supplies
//       bool (*guard)(void* context, <event parameters>);
//       void (*action)(void* context, <event parameters>);
//       void (*StartTimer)(...); void (*CancelTimer)(...);      [after(...) transitions]
//       void (*Trace)(void* context, kind, const char* name);   [trace; may be NULL]
//       void (*Lock)(void* context); void (*Unlock)(void* context);   [threadSafe]
//   } <P>_Hooks;
//   typedef struct { <params> } <P>_<Event>Args;          one per event with parameters
//   typedef struct { event; union { <P>_<Event>Args <Event>; ... } args; } <P>_QueuedEvent;   [queue]
//   typedef struct <P> { hooks, context, active[RegionCount], history[RegionCount], exited, pending[],
//                        timerGeneration[], timerArmed[], queue[], queueHead, queueCount, args } <P>;
//                                                        members as needed
//   <P>_Init, <P>_Start, <P>_Dispatch, <P>_Dispatch<Event>, <P>_DispatchTimeout, <P>_Post, <P>_Post<Event>,
//   <P>_Current, <P>_IsIn, <P>_IsFinished, <P>_ParentOf, <P>_StateName, <P>_EventName
//
// RUNTIME MODEL
// The active configuration is stored as one slot per region: `active[r]` is the active state of region r, or
// None. Region 0 is the top level and the regions of one state are numbered consecutively, so a state's own
// regions are FirstRegionOf(s) .. FirstRegionOf(s) + RegionsOf(s) - 1 and a state s is active exactly when
// `active[RegionOf(s)] == s`. Orthogonal states simply own several consecutive slots. The source (<P>.c) holds:
//   - structure queries: RegionOf, FirstRegionOf, RegionsOf, IsFinalState, ParentOf, StateName, EventName;
//   - timer helpers: StartTimers, CancelTimers, TimerIndex;
//   - entry/exit dispatch: OnEntry, OnExit;
//   - the run-to-completion core, the same algorithm as engine.ts: Innermost, AllRegionsFinal, MarkCompletion,
//     ExitState, EnterState, EnterRegion, EnterDefault, EnterHistory, EnterDown, Fire_<n> (choice points),
//     HandleEvent, RunCompletions, DispatchState, DispatchCore, Enqueue, DrainQueue;
//   - the public API.
// The body is written first and the prototypes of all static functions are collected on the way, so that they
// can be printed above the body and the functions may call each other in any order (EnterDown and EnterRegion,
// for instance, are mutually recursive).
//
// STYLES
// Both styles implement exactly the same algorithm; they differ only in how the machine's structure and its
// transitions are encoded:
//   - 'switch': every structure query is a `switch` over the state, and HandleEvent is a nested
//     `switch (state) { switch (event) { ... } }` with each transition expanded in place: guard test, Trace,
//     ExitState of a root computed at generation time, the actions, EnterDown. No data tables at all.
//   - 'table': the structure lives in constant arrays indexed by state (kParent, kRegionOf, kFirstRegion,
//     kRegionsOf, kStateNames, kIsFinal, kHistoryKind, kCompletion), entry/exit/initial actions in arrays of
//     function pointers (kEntry, kExit, and kRegions for the regions of composite states), and transitions in one constant array of TransitionRow that
//     HandleEvent scans linearly; TryRow interprets a row and computes the exit root at run time. Every guard
//     and action list gets a small static wrapper (Guard_<n>, Transition_<n>, Entry_<State>, ...) because a
//     table cell can only hold one function pointer with a fixed signature.
//
// OPTIONS (from the diagram's `codegen` settings)
//   - trace: adds <P>_TraceKind, the optional Trace hook and a static Trace() wrapper that tolerates NULL, and
//     calls it on Start, Event, Ignored, Transition (before any exit), Exit (before the exit actions) and Enter
//     (before the entry actions). Transition names are string literals ("A -> B", "A (internal)",
//     "A -> B (history)", "A -> B (choice)"), so tracing never allocates.
//   - threadSafe: adds the Lock/Unlock hooks. Start, Dispatch, Dispatch<Event>, DispatchTimeout, Current, IsIn
//     and IsFinished bracket their bodies with Lock/Unlock. Init, Post, Post<Event>, ParentOf, StateName and
//     EventName do not lock (Post is meant to be called from hooks, which already run under the lock). C has
//     no exceptions, so an explicit Unlock before the single `return` is enough.
//   - queue: adds a fixed ring buffer of <P>_QueueCapacity entries inside the machine and the Post functions.
//     Posted events are processed after the current event and its completion transitions, in FIFO order.
// Other features are switched on by the diagram itself, and each pulls in only the code it needs: event
// parameters (the `args` pointer and the Dispatch<Event>/Post<Event> functions), history, after(...) timers,
// completion transitions, orthogonal regions, internal transitions and choice points.
//
// DIFFERENCES FROM THE C++ GENERATOR (cpp.ts)
//   - C++ emits one header with an abstract class whose hooks are pure virtual member functions; C emits a
//     header/source pair and takes the hooks as function pointers in a <P>_Hooks struct, each receiving the
//     `void* context` given to Init as its first argument.
//   - No constructor and no RAII: the machine is a plain struct that <P>_Init initialises, and the lock is
//     released explicitly instead of by a ScopedLock.
//   - No namespaces or `enum class`: names are prefixed instead, so namespaces are flattened into <P>.
//   - Event arguments: C++ calls a typed ArgsOf<Event>() accessor; C casts `m->args` to the right
//     `<P>_<Event>Args*` inline at every hook call.
//   - In the table style C++ can point a cell straight at a single parameterless hook; C always needs a wrapper,
//     because every hook call must pass `m->context`.
//   - C needs forward prototypes, and placeholders where C99 forbids empty constructs (`int unused_;` in an
//     otherwise empty hooks struct, `<P>_Event_None_` in an empty event enum, no zero-length arrays).
//   - The Args structs store each parameter as storageType() of its declared type (no reference, no top-level
//     const), so that Dispatch<Event> and Post<Event> can assign it; C++ stores the declared type in its Args
//     struct and uses storageType() only for the queue.
// The generation-time helpers exitRoot(), completionOwner(), storageType() and indexType() are shared with
// cpp.ts so that both targets derive identical static information from the model.
import { alwaysFires, COMPLETION_EVENT, isExhaustive, Machine, MBranch, MState, MTransition, Style } from '../model';
import { completionOwner, exitRoot, indexType, storageType } from './cpp';
import { Writer } from './writer';

/**
 * Prefix of every public C identifier: the namespace (if any) joined with the machine name.
 * `::` and `.` separators in the namespace become underscores, e.g. namespace `Demo` and machine `TrafficLight`
 * give `Demo_TrafficLight`. The prefix is also the name of the machine struct type and, upper-cased, the stem of
 * the include guard.
 */
export function cPrefix(m: Machine): string {
    const ns = (m.namespace ?? '').replace(/::|\./g, '_');
    return ns ? `${ns}_${m.name}` : m.name;
}

/**
 * Generates the C99 implementation of a state machine.
 *
 * @param m     analysed machine (must be free of issues)
 * @param style `'switch'` for switch-statement code, `'table'` for constant tables (see the file overview)
 * @returns the contents of `<Name>.h` and `<Name>.c`; the source includes the header by the machine name
 */
export function generateC(m: Machine, style: Style): { header: string; source: string } {
    return { header: header(m), source: source(m, style) };
}

/**
 * Members of the generated `<P>_TraceKind` enumeration, with the comment explaining the `name` argument that the
 * Trace hook receives for each kind. The order is part of the public interface (the enumerator values).
 */
const TRACE_KINDS = [
    ['Start', 'name = machine name'],
    ['Event', 'name = event being dispatched'],
    ['Ignored', 'name = event no state handled'],
    ['Transition', 'name = "Source -> Target"'],
    ['Exit', 'name = state being exited'],
    ['Enter', 'name = state being entered']
];

/**
 * Naming helpers and facts about the machine that both the header and the source generator need.
 *
 * - `P`: identifier prefix (see cPrefix).
 * - `st(s)` / `ev(e)`: the C enumerator of a state (`None` for null/undefined, i.e. the top level) or an event.
 * - `paramEvents` / `hasArgs`: events that carry parameters, and whether there are any.
 * - `hasHistory` / `hasTimers`: whether any state has a history pseudostate / any after(...) transition exists.
 * - `rejected`: events that the untyped Dispatch and Post must refuse: events with parameters (they must go
 *   through Dispatch<Event>/Post<Event> so that `args` is valid) and the internal Completion event.
 * - `hookDecls(hook)`: parameter list of a hook's function pointer, `void* context` followed by the parameters
 *   of the event(s) the hook is used with (model.ts guarantees that they agree).
 * - `decay(type)`: type of an Args struct member for a parameter (storageType: drops a reference and a
 *   top-level `const`, so that the member can be assigned, but keeps the `const` of a pointee).
 */
function info(m: Machine) {
    const P = cPrefix(m);
    const paramEvents = m.events.filter(e => (m.params.get(e) ?? []).length > 0);
    return {
        P,
        st: (s: MState | null | undefined) => `${P}_State_${s ? s.name : 'None'}`,
        ev: (e: string) => `${P}_Event_${e}`,
        paramEvents,
        hasArgs: paramEvents.length > 0,
        hasHistory: m.states.some(s => s.history),
        hasTimers: m.timers.length > 0,
        rejected: [...paramEvents, ...(m.completion ? [COMPLETION_EVENT] : [])],
        hookDecls: (hook: string) => ['void* context', ...(m.hookParams.get(hook) ?? []).map(p => p.decl)].join(', '),
        decay: storageType
    };
}

/**
 * Generates the public header `<Name>.h`: the State/Event/TraceKind enumerations, the size constants, the hooks
 * struct, the event argument and queue entry structs, the machine struct and the prototypes of the public API.
 * The header is usable from C++ (`extern "C"`) and depends only on <stdbool.h> and <stddef.h>.
 */
function header(m: Machine): string {
    const { P, st, ev, paramEvents, hasArgs, hasTimers, hookDecls, decay } = info(m);
    const w = new Writer(false);
    const guardMacro = `${P.toUpperCase()}_H`;
    w.line(`/* ${m.name}: hierarchical state machine generated by MachinaState (C99). */`);
    w.line('/* Do not edit by hand. Fill in a hooks structure and pass it to ' + `${P}_Init. */`);
    w.line(`#ifndef ${guardMacro}`);
    w.line(`#define ${guardMacro}`);
    w.line('');
    w.line('#include <stdbool.h>');
    w.line('#include <stddef.h>');
    w.line('');
    w.line('#ifdef __cplusplus');
    w.line('extern "C" {');
    w.line('#endif');
    w.line('');
    // State enumeration in pre-order, so the values double as indices into all per-state arrays. Substates are
    // annotated with their parent. The trailing None sentinel equals StateCount and must never be used as an
    // index; the runtime checks for it wherever it can occur.
    w.open('typedef enum');
    for (const s of m.states) {
        w.line(`${st(s)},${s.parent ? `   /* in ${s.parent.name} */` : ''}`);
    }
    w.line(st(null));
    w.close(`} ${P}_State;`);
    w.line('');
    // Event enumeration: user events, then one generated event per distinct timeout (named
    // <State>_After<n>ms), then Completion if any completion transition exists. Generated events are annotated.
    w.open('typedef enum');
    m.events.forEach((e, i) => {
        const timer = m.timers.find(x => x.event === e);
        const note = timer ? `   /* after(${timer.milliseconds} ms) in ${timer.state.name} */` : e === COMPLETION_EVENT && m.completion ? '   /* internal: completion of a state */' : '';
        w.line(`${ev(e)}${i < m.events.length - 1 ? ',' : ''}${note}`);
    });
    // C99 does not allow an empty enumeration, so a machine without any event gets a placeholder enumerator.
    // EventCount stays 0.
    if (m.events.length === 0) {
        w.line(`${P}_Event_None_`);
    }
    w.close(`} ${P}_Event;`);
    w.line('');
    if (m.trace) {
        // The last enumerator gets a space instead of a comma so that its comment lines up with the others.
        w.open('typedef enum');
        TRACE_KINDS.forEach(([k, note], i) => w.line(`${P}_Trace_${k}${i < TRACE_KINDS.length - 1 ? ',' : ' '}   /* ${note} */`));
        w.close(`} ${P}_TraceKind;`);
        w.line('');
    }
    // Sizes as enumeration constants: in C these are integer constant expressions usable as array bounds, unlike
    // `static const` variables. TimerCount and QueueCapacity exist only when the feature is used.
    w.open('enum');
    const constants = [[`${P}_StateCount`, m.states.length], [`${P}_EventCount`, m.events.length], [`${P}_RegionCount`, m.regions.length]];
    if (hasTimers) {
        constants.push([`${P}_TimerCount`, m.timers.length]);
    }
    if (m.queue) {
        constants.push([`${P}_QueueCapacity`, m.queueCapacity]);
    }
    constants.forEach(([n, v], i) => w.line(`${n} = ${v}${i < constants.length - 1 ? ',' : ''}`));
    w.close('};');
    w.line('');

    // The hooks struct: the C counterpart of the C++ class's pure virtual methods. Guards return bool, actions
    // return nothing; both receive the context pointer and the parameters of their triggering event. Entry,
    // exit and initial actions never have parameters (enforced by model.ts).
    w.line('/* Guards, actions and services supplied by the application. Every member must be set');
    w.line(m.trace ? '   (except Trace, which may be NULL). `context` is the pointer passed to Init. */' : '   `context` is the pointer passed to Init. */');
    w.open('typedef struct');
    if (m.guards.length) {
        w.line('/* Guards */');
        m.guards.forEach(g => w.line(`bool (*${g})(${hookDecls(g)});`));
    }
    if (m.actions.length) {
        w.line('/* Actions */');
        m.actions.forEach(a => w.line(`void (*${a})(${hookDecls(a)});`));
    }
    // Timer services. The machine passes a generation number to StartTimer; the application hands it back to
    // DispatchTimeout, which lets the machine discard timeouts from timers that were cancelled or restarted.
    if (hasTimers) {
        w.line('/* Timers for after(...) transitions: when a timer elapses, call DispatchTimeout(timeout, generation). */');
        w.line(`void (*StartTimer)(void* context, ${P}_Event timeout, unsigned milliseconds, unsigned generation);`);
        w.line(`void (*CancelTimer)(void* context, ${P}_Event timeout);`);
    }
    if (m.trace) {
        w.line('/* Logs state machine activity (optional). */');
        w.line(`void (*Trace)(void* context, ${P}_TraceKind kind, const char* name);`);
    }
    if (m.threadSafe) {
        w.line('/* Mutual exclusion around Start, Dispatch, Dispatch<Event>, DispatchTimeout, Current, IsIn and');
        w.line('   IsFinished. Init, Post, Post<Event>, ParentOf, StateName and EventName do not lock. Hooks must');
        w.line('   not call the functions that lock. */');
        w.line('void (*Lock)(void* context);');
        w.line('void (*Unlock)(void* context);');
    }
    // A struct without members is not valid C99, so a machine without any hook gets a dummy member.
    if (!m.guards.length && !m.actions.length && !hasTimers && !m.trace && !m.threadSafe) {
        w.line('int unused_;');
    }
    w.close(`} ${P}_Hooks;`);
    w.line('');

    // One argument struct per event with parameters. Dispatch<Event> builds one on its stack and points
    // `machine->args` at it for the duration of the call; with the queue option the structs are also stored by
    // value in the queue entries.
    if (hasArgs) {
        for (const e of paramEvents) {
            w.open('typedef struct');
            m.params.get(e)!.forEach(p => w.line(`${decay(p.type)} ${p.name};`));
            w.close(`} ${P}_${e}Args;`);
            w.line('');
        }
    }
    // Queue entry: the event plus a union of all argument structs (only the one matching `event` is valid).
    if (m.queue) {
        w.open('typedef struct');
        w.line(`${P}_Event event;`);
        if (hasArgs) {
            w.open('union');
            paramEvents.forEach(e => w.line(`${P}_${e}Args ${e};`));
            w.close('} args;');
        }
        w.close(`} ${P}_QueuedEvent;`);
        w.line('');
    }

    // The machine instance. It must be visible in the header so that the application can allocate it
    // (statically, on the stack or embedded in its own structs); the members are nonetheless private.
    //   active[]           active state per region (None if the region is not active)
    //   history[]          per region: the state last exited from it (None = none since Start); restored by
    //                      transitions to history pseudostates
    //   exited             outermost state exited by the latest transition of the current step (orthogonal
    //                      states only; see DispatchState)
    //   pending[]          per state: a completion event has been raised and not yet processed
    //   timerGeneration[]  per timer: incremented on every start, handed to StartTimer
    //   timerArmed[]       per timer: started, and neither cancelled nor dispatched since
    //   queue/Head/Count   ring buffer of posted events
    //   args               argument struct of the event being dispatched (NULL for events without parameters)
    w.line('/* Machine instance; treat all members as private. */');
    w.open(`typedef struct ${P}`);
    w.line(`const ${P}_Hooks* hooks;`);
    w.line('void* context;');
    w.line(`${P}_State active[${P}_RegionCount];   /* active state per region; region 0 is the top level */`);
    if (m.states.some(s => s.history)) {
        w.line(`${P}_State history[${P}_RegionCount];   /* state last exited per region */`);
    }
    if (m.states.some(s => s.regions.length > 1)) {
        w.line(`${P}_State exited;                    /* outermost state exited by the latest transition */`);
    }
    if (m.completion) {
        w.line(`bool pending[${P}_StateCount];        /* completion events not yet processed */`);
    }
    if (hasTimers) {
        w.line(`unsigned timerGeneration[${P}_TimerCount];`);
        w.line(`bool timerArmed[${P}_TimerCount];`);
    }
    if (m.queue) {
        w.line(`${P}_QueuedEvent queue[${P}_QueueCapacity];`);
        w.line('size_t queueHead;');
        w.line('size_t queueCount;');
    }
    if (hasArgs) {
        w.line('const void* args;   /* arguments of the event being dispatched */');
    }
    w.close(`} ${P};`);
    w.line('');

    // Public API. The prototypes name the instance parameter `machine`; the definitions in the source call it `m`.
    w.line('/* Binds the hooks; call once before Start. */');
    w.line(`void ${P}_Init(${P}* machine, const ${P}_Hooks* hooks, void* context);`);
    w.line('/* Resets the machine (running timers are cancelled, history is forgotten) and enters the initial state configuration. */');
    w.line(`void ${P}_Start(${P}* machine);`);
    w.line('/* Dispatches an event to the innermost active states first. Returns false if it was not handled. */');
    w.line(`bool ${P}_Dispatch(${P}* machine, ${P}_Event event);`);
    // Typed dispatch functions take the parameters exactly as declared in the diagram.
    for (const e of paramEvents) {
        w.line(`bool ${P}_Dispatch${e}(${P}* machine, ${m.params.get(e)!.map(p => p.decl).join(', ')});`);
    }
    if (hasTimers) {
        w.line('/* Dispatches a timeout reported by StartTimer; stale timeouts are ignored. */');
        w.line(`bool ${P}_DispatchTimeout(${P}* machine, ${P}_Event timeout, unsigned generation);`);
    }
    if (m.queue) {
        w.line('/* From inside a hook only: queues an event processed after the current one. False if the queue is full. */');
        w.line(`bool ${P}_Post(${P}* machine, ${P}_Event event);`);
        for (const e of paramEvents) {
            w.line(`bool ${P}_Post${e}(${P}* machine, ${m.params.get(e)!.map(p => p.decl).join(', ')});`);
        }
    }
    w.line('/* Innermost active state (following the first region of orthogonal states). */');
    w.line(`${P}_State ${P}_Current(const ${P}* machine);`);
    w.line(`bool ${P}_IsIn(const ${P}* machine, ${P}_State state);`);
    w.line('/* True once a top-level final state has been reached. */');
    w.line(`bool ${P}_IsFinished(const ${P}* machine);`);
    w.line(`${P}_State ${P}_ParentOf(${P}_State state);`);
    w.line(`const char* ${P}_StateName(${P}_State state);`);
    w.line(`const char* ${P}_EventName(${P}_Event event);`);
    w.line('');
    w.line('#ifdef __cplusplus');
    w.line('}');
    w.line('#endif');
    w.line('');
    w.line(`#endif /* ${guardMacro} */`);
    return w.toString();
}

/**
 * Generates the implementation `<Name>.c` in the given style.
 *
 * The body is accumulated in `W` while the prototypes of all static functions defined with `def` are collected
 * in `prototypes`; at the end a short preamble (banner, `#include`, the prototype block) is put in front of it.
 * Every emitted function receives the machine as `m`.
 *
 * @param m     analysed machine
 * @param style `'switch'` or `'table'`
 * @returns the complete source file
 */
function source(m: Machine, style: Style): string {
    const { P, st, ev, paramEvents, hasArgs, hasHistory, hasTimers, rejected } = info(m);
    const table = style === 'table';
    // Name of the machine struct type; identical to the prefix (`typedef struct P { ... } P;`).
    const M = P;
    const topFinals = m.states.filter(s => s.isFinal && !s.parent);
    const hasInternal = m.transitions.some(t => t.internal);
    // Transitions that lead into a choice point; each becomes a Fire_<n> function.
    const compound = m.transitions.filter(t => t.branches);
    const orthogonal = m.states.some(s => s.regions.length > 1);
    const historyStates = m.states.filter(s => s.history);
    // Call of EnterDown; its last parameter (enter the target through its history pseudostate) only exists
    // when the diagram has history pseudostates.
    const enterDown = (from: string, target: string, history: string) => `EnterDown(m, ${from}, ${target}${hasHistory ? `, ${history}` : ''})`;

    // Hook calls. A hook triggered by event `e` receives that event's arguments, read from the argument struct
    // that `m->args` points to during the dispatch (cast to the event's own Args type). Entry, exit and initial
    // actions are called without an event and so never get arguments.
    const callArgs = (e: string) => (m.params.get(e) ?? []).map(p => `, ((const ${P}_${e}Args*)m->args)->${p.name}`).join('');
    const call = (hook: string, e?: string) => `m->hooks->${hook}(m->context${e ? callArgs(e) : ''})`;
    // Guard expression of a transition or branch, honouring `!guard` negation.
    const guardCall = (t: { guard?: { name: string; negate: boolean } }, e: string) => `${t.guard!.negate ? '!' : ''}${call(t.guard!.name, e)}`;
    // C string literal reported to Trace when the transition fires; the same text as the engine and C++ report.
    const transitionName = (t: MTransition) =>
        `"${t.source.name}${t.internal ? ' (internal)' : ` -> ${t.target.name}${t.history ? ' (history)' : ''}`}"`;
    // Choice-point functions are numbered by the transition's index in m.transitions (so are Guard_/Transition_).
    const fireName = (t: MTransition) => `Fire_${m.transitions.indexOf(t)}`;
    // Statement lists that are empty when the corresponding option is off, so callers can splice them in freely.
    const trace = (kind: string, name: string) => (m.trace ? [`Trace(m, ${P}_Trace_${kind}, ${name});`] : []);
    const lock = (target = 'm') => (m.threadSafe ? [`${target}->hooks->Lock(${target}->context);`] : []);
    const unlock = (target = 'm') => (m.threadSafe ? [`${target}->hooks->Unlock(${target}->context);`] : []);
    // The body is written first so that prototypes of all internal functions can be emitted above it.
    const W = new Writer(false);
    const prototypes: string[] = [];
    /**
     * Emits `switch (subject) { case ...: ...; default: ... }`.
     *
     * When there are no cases a switch with only a default label would be pointless (and some compilers warn),
     * so the default lines are emitted directly instead, minus any `break;`. The names in `unused` are then cast
     * to void, because without the switch the parameters would otherwise be unused and trip `-Wextra -Werror`.
     *
     * @param subject      expression switched on
     * @param cases        groups of case labels sharing the same statements (which must end in break/return)
     * @param defaultLines statements of the default label
     * @param unused       parameter names to mark as used when no case is generated
     */
    const sw = (subject: string, cases: { labels: string[]; lines: string[] }[], defaultLines: string[], unused: string[] = []) => {
        if (cases.length === 0) {
            unused.forEach(u => W.line(`(void)${u};`));
            defaultLines.filter(l => l !== 'break;').forEach(l => W.line(l));
            return;
        }
        W.open(`switch (${subject})`);
        for (const c of cases) {
            c.labels.forEach(l => W.line(`case ${l}:`));
            W.indent();
            c.lines.forEach(l => W.line(l));
            W.dedent();
        }
        W.line('default:');
        W.indent();
        defaultLines.forEach(l => W.line(l));
        W.dedent();
        W.close();
    };
    /** Defines a function without a prototype (public functions, or static ones defined before their only use). */
    const pub = (signature: string, f: () => void) => {
        W.open(signature);
        f();
        W.close();
        W.line('');
    };
    /** Defines an internal function and declares its prototype at the top of the file. */
    const def = (signature: string, f: () => void) => {
        prototypes.push(`${signature};`);
        pub(signature, f);
    };
    /** Emits several statements at the current indentation. */
    const L = (ls: string[]) => ls.forEach(l => W.line(l));
    /**
     * Static array indexed by state, one commented entry per line.
     *
     * @param decl   element type and array name without `static const`, e.g. `unsigned char kRegionOf`
     *               (`char* const kStateNames` yields `static const char* const kStateNames`)
     * @param values one initialiser per state, in state order
     * @param note   optional comment placed after the `=`
     */
    const perState = (decl: string, values: string[], note = '') => {
        W.open(`static const ${decl}[${P}_StateCount] =${note ? `   /* ${note} */` : ''}`);
        values.forEach((v, i) => W.line(`${v},   /* ${m.states[i].name} */`));
        W.close('};');
    };

    /**
     * Emits the entry half of an external transition: enter the states from below `lca` down to `target`.
     * For a transition to a history pseudostate, `target` is the composite that owns it, and EnterDown restores
     * its recorded configuration (EnterHistory) instead of entering it by default.
     */
    const emitEnter = (lca: MState | null, target: MState, history: boolean) => {
        W.line(`${enterDown(st(lca), st(target), history ? 'true' : 'false')};`);
    };
    /**
     * Emits the firing of a plain transition (no choice point) for the switch style, ending in `return true;`.
     *
     * UML order: Trace, exit every active state below the least common ancestor (LCA) innermost first, run the
     * transition actions, then enter from below the LCA down to the target outermost first. The LCA is always a
     * proper ancestor of the source, so an external self transition exits and re-enters its state. Exiting the
     * single child of the LCA on the source's path (exitRoot, resolved at generation time) exits everything
     * below it, including the source and its active substates. An internal transition runs only its actions and
     * leaves the configuration (and so timers and entry/exit actions) untouched.
     */
    const emitTransition = (t: MTransition) => {
        L(trace('Transition', transitionName(t)));
        if (!t.internal) {
            W.line(`ExitState(m, ${st(exitRoot(t.source, t.lca))});`);
        }
        t.actions.forEach(a => W.line(`${call(a, t.event)};`));
        if (!t.internal) {
            emitEnter(t.lca, t.target, t.history);
        }
        W.line('return true;');
    };
    /**
     * Emits the branches of a choice point (shared by both styles; the code ends up in Fire_<n>).
     *
     * MachinaState uses junction semantics: all guards along a path are evaluated before anything is exited, and
     * only a complete path to a state fires. Branches are already sorted with guarded ones first and the single
     * `[else]` (unguarded) branch last. A guarded branch becomes `if (guard) { ... }`; if it leads into a further
     * choice point whose guards all fail, control falls out of the `if` and the next sibling branch is tried,
     * exactly like the engine's fireBranches. The unguarded branch is emitted without an `if` and ends the loop,
     * since nothing after it could be reached. A complete path emits Trace, ExitState of its own exit root (each
     * branch may have a different target and LCA), the actions of all segments in order (incoming transition
     * first, accumulated in `prefix`), the entry into the target and `return true;`.
     *
     * @param t        the transition entering the (outermost) choice point; supplies the event and source
     * @param branches branches of the current choice point
     * @param prefix   actions of the segments already traversed
     */
    const emitBranches = (t: MTransition, branches: MBranch[], prefix: string[]) => {
        for (const b of branches) {
            if (b.guard) {
                W.open(`if (${guardCall(b, t.event)})`);
            }
            if (b.branches) {
                emitBranches(t, b.branches, [...prefix, ...b.actions]);
            } else {
                L(trace('Transition', `"${t.source.name} -> ${b.target!.name}${b.history ? ' (history)' : ''} (choice)"`));
                W.line(`ExitState(m, ${st(exitRoot(t.source, b.lca))});`);
                [...prefix, ...b.actions].forEach(a => W.line(`${call(a, t.event)};`));
                emitEnter(b.lca, b.target!, b.history);
                W.line('return true;');
            }
            if (b.guard) {
                W.close();
            } else {
                break;
            }
        }
    };

    // ---------------------------------------------------------------- structure queries
    // RegionOf(s): region that contains s. FirstRegionOf(s) / RegionsOf(s): range of s's own regions; for a
    // simple state RegionsOf is 0 and FirstRegionOf is a meaningless 0, so every loop over own regions is empty.
    // ParentOf/StateName/EventName are public; RegionOf etc. are internal.
    if (table) {
        // Table style: one constant array per query. The region columns use the smallest unsigned type that
        // holds every region index and count (indexType), which keeps the tables small without limiting the
        // number of regions. The None sentinel is out of range for every per-state array, hence the explicit
        // None checks in the public lookups below.
        const regionIndex = indexType(m.regions.length);
        perState(`${P}_State kParent`, m.states.map(s => st(s.parent)));
        perState(`${regionIndex} kRegionOf`, m.states.map(s => String(s.region.index)), 'region that contains the state');
        perState(`${regionIndex} kFirstRegion`, m.states.map(s => String(s.regions[0]?.index ?? 0)), 'first own region');
        perState(`${regionIndex} kRegionsOf`, m.states.map(s => String(s.regions.length)), 'number of own regions');
        perState('char* const kStateNames', m.states.map(s => `"${s.name}"`));
        // Zero-length arrays are not valid C, so the event name table only exists when there are events.
        if (m.events.length) {
            W.open(`static const char* const kEventNames[${P}_EventCount] =`);
            m.events.forEach(e => W.line(`"${e}",`));
            W.close('};');
        }
        // Finality is only needed at run time to decide whether every region of an orthogonal state has
        // completed (AllRegionsFinal); with one region, completionOwner already settles it at generation time.
        if (orthogonal && m.completion) {
            perState('bool kIsFinal', m.states.map(s => (s.isFinal ? 'true' : 'false')));
        }
        if (hasHistory) {
            perState('unsigned char kHistoryKind', m.states.map(s => (s.history === 'deep' ? '2' : s.history ? '1' : '0')), '0 = none, 1 = shallow, 2 = deep');
        }
        // kCompletion[s]: the state whose completion event is raised when s is entered as a leaf: s itself if it
        // has completion transitions, its parent if s is a final state and the parent has them, otherwise None.
        if (m.completion) {
            perState(`${P}_State kCompletion`, m.states.map(s => st(completionOwner(m, s))), 'state whose completion transitions fire when this state is reached');
        }
        W.line('');
        def(`static size_t RegionOf(${P}_State state)`, () => W.line('return kRegionOf[state];'));
        def(`static size_t FirstRegionOf(${P}_State state)`, () => W.line('return kFirstRegion[state];'));
        def(`static size_t RegionsOf(${P}_State state)`, () => W.line('return kRegionsOf[state];'));
        // Called with the content of a region slot, which may be None (an orthogonal state whose later regions
        // have not been entered yet), so None must be checked before indexing.
        if (orthogonal && m.completion) {
            def(`static bool IsFinalState(${P}_State state)`, () => W.line(`return state != ${st(null)} && kIsFinal[state];`));
        }
        pub(`${P}_State ${P}_ParentOf(${P}_State state)`, () => W.line(`return state == ${st(null)} ? ${st(null)} : kParent[state];`));
        pub(`const char* ${P}_StateName(${P}_State state)`, () => W.line(`return state == ${st(null)} ? "None" : kStateNames[state];`));
        pub(`const char* ${P}_EventName(${P}_Event event)`, () => {
            if (m.events.length) {
                W.line('return kEventNames[event];');
            } else {
                W.line('(void)event;');
                W.line('return "";');
            }
        });
    } else {
        // Switch style: each query is a switch whose cases group the states sharing a result; the most common
        // result (region 0, no own regions, no parent, ...) is left to the default label to keep the code short.
        const byRegion = new Map<number, MState[]>();
        m.states.forEach(s => byRegion.set(s.region.index, [...(byRegion.get(s.region.index) ?? []), s]));
        def(`static size_t RegionOf(${P}_State state)`, () =>
            sw('state', [...byRegion].filter(([r]) => r !== 0).map(([r, list]) => ({ labels: list.map(st), lines: [`return ${r};`] })), ['return 0;'], ['state'])
        );
        const composites = m.states.filter(s => s.regions.length > 0);
        def(`static size_t FirstRegionOf(${P}_State state)`, () =>
            sw('state', composites.map(s => ({ labels: [st(s)], lines: [`return ${s.regions[0].index};`] })), ['return 0;'], ['state'])
        );
        // Composites are grouped by their number of regions (1 for ordinary composites, more for orthogonal ones).
        const counts = new Map<number, MState[]>();
        composites.forEach(s => counts.set(s.regions.length, [...(counts.get(s.regions.length) ?? []), s]));
        def(`static size_t RegionsOf(${P}_State state)`, () =>
            sw('state', [...counts].map(([n, list]) => ({ labels: list.map(st), lines: [`return ${n};`] })), ['return 0;'], ['state'])
        );
        // Only needed by AllRegionsFinal (see the table branch); None falls through to `return false`.
        if (orthogonal && m.completion) {
            const finals = m.states.filter(s => s.isFinal);
            def(`static bool IsFinalState(${P}_State state)`, () =>
                sw('state', finals.length ? [{ labels: finals.map(st), lines: ['return true;'] }] : [], ['return false;'], ['state'])
            );
        }
        // Children are grouped under their parent; top-level states and None return None by default.
        pub(`${P}_State ${P}_ParentOf(${P}_State state)`, () =>
            sw(
                'state',
                m.states.filter(s => s.children.length > 0).map(p => ({ labels: p.children.map(st), lines: [`return ${st(p)};`] })),
                [`return ${st(null)};`],
                ['state']
            )
        );
        pub(`const char* ${P}_StateName(${P}_State state)`, () =>
            sw('state', m.states.map(s => ({ labels: [st(s)], lines: [`return "${s.name}";`] })), ['return "None";'])
        );
        pub(`const char* ${P}_EventName(${P}_Event event)`, () =>
            sw('event', m.events.map(e => ({ labels: [ev(e)], lines: [`return "${e}";`] })), ['return "";'], ['event'])
        );
    }

    // Internal wrapper so that every trace point is a one-liner and the Trace hook may be left NULL.
    if (m.trace) {
        def(`static void Trace(${M}* m, ${P}_TraceKind kind, const char* name)`, () => {
            W.open('if (m->hooks->Trace != NULL)');
            W.line('m->hooks->Trace(m->context, kind, name);');
            W.close();
        });
    }

    // ---------------------------------------------------------------- timers
    // Each distinct after(...) of a state is one timer (index = MTimer.index) with its own generated event.
    // Timers are started when their state has been entered (after its entry actions, from EnterState) and
    // cancelled when it is exited (before its exit actions, from ExitState). Every start increments the timer's
    // generation; DispatchTimeout accepts a timeout only while the timer is armed and the generation matches,
    // so a timeout that was already in flight when its state was left (or left and re-entered) is ignored.
    // Timers are one-shot: dispatching a timeout disarms its timer (DispatchCore). An external self transition
    // restarts the timer; an internal transition does not touch it. The timer functions are emitted as switches
    // in both styles.
    if (hasTimers) {
        /**
         * Defines `static void <name>(m, state)`: a switch over the states owning timers, emitting `body` for each
         * of the state's timers.
         *
         * @param body statements for one timer, given its index, its event enumerator and its duration literal
         */
        const timerFn = (name: string, body: (i: string, event: string, ms: string) => string[]) =>
            def(`static void ${name}(${M}* m, ${P}_State state)`, () => {
                const owners = [...new Set(m.timers.map(x => x.state))];
                sw(
                    'state',
                    owners.map(s => ({
                        labels: [st(s)],
                        lines: [...m.timers.filter(x => x.state === s).flatMap(x => body(String(x.index), ev(x.event), `${x.milliseconds}u`)), 'break;']
                    })),
                    ['break;']
                );
            });
        timerFn('StartTimers', (i, e, ms) => [`++m->timerGeneration[${i}];`, `m->timerArmed[${i}] = true;`, `m->hooks->StartTimer(m->context, ${e}, ${ms}, m->timerGeneration[${i}]);`]);
        timerFn('CancelTimers', (i, e) => [`m->timerArmed[${i}] = false;`, `m->hooks->CancelTimer(m->context, ${e});`]);
        // Maps a timeout event back to its timer index (-1 for any other event), for DispatchTimeout.
        def(`static int TimerIndex(${P}_Event event)`, () =>
            sw('event', m.timers.map(x => ({ labels: [ev(x.event)], lines: [`return ${x.index};`] })), ['return -1;'])
        );
    }

    // ---------------------------------------------------------------- entry / exit actions
    // OnEntry(m, s) / OnExit(m, s) run the entry / exit actions of one state, without arguments.
    if (table) {
        // Table style: per-state arrays of Handler (NULL = nothing to do). A table cell holds one function
        // pointer, so each non-empty action list gets a wrapper Entry_<State> / Exit_<State> / Init_<region>.
        W.line(`typedef void (*Handler)(${M}* m);`);
        W.line('');
        /**
         * Defines a static wrapper running `actions` (with the arguments of event `e`, if given).
         * @returns the wrapper's name for use in a table, or `NULL` when there are no actions
         */
        const handler = (actions: string[], name: string, e?: string): string => {
            if (actions.length === 0) {
                return 'NULL';
            }
            def(`static void ${name}(${M}* m)`, () => actions.forEach(a => W.line(`${call(a, e)};`)));
            return name;
        };
        const entries = m.states.map(s => handler(s.entry, `Entry_${s.name}`));
        const exits = m.states.map(s => handler(s.exit, `Exit_${s.name}`));
        perState('Handler kEntry', entries);
        perState('Handler kExit', exits);
        // kRegions[r - 1]: what entering region r of a composite state by default means: run the initial
        // transition's actions, then enter its target (possibly nested deeper) from the owner. The top level
        // (region 0) has no row: Start performs its entry itself (from m.initial) and EnterRegion is never called
        // for it. Without composite states there would be no rows at all (zero-length arrays are not valid C),
        // so the table is omitted and EnterRegion has nothing to do.
        const owned = m.regions.filter(r => r.owner);
        if (owned.length) {
            const inits = owned.map(r => handler(r.initial!.actions, `Init_${r.index}`));
            W.line('/* owner, initial target, initial action; row r - 1 describes region r */');
            W.line(`static const struct { ${P}_State owner; ${P}_State initial; Handler action; } kRegions[${P}_RegionCount - 1] = {`);
            W.indent();
            owned.forEach((r, i) => W.line(`{ ${st(r.owner)}, ${st(r.initial!.target)}, ${inits[i]} },   /* region ${r.index} */`));
            W.dedent();
            W.line('};');
            W.line('');
        }
        def(`static void OnEntry(${M}* m, ${P}_State state)`, () => {
            W.open('if (kEntry[state] != NULL)');
            W.line('kEntry[state](m);');
            W.close();
        });
        def(`static void OnExit(${M}* m, ${P}_State state)`, () => {
            W.open('if (kExit[state] != NULL)');
            W.line('kExit[state](m);');
            W.close();
        });
    } else {
        // Switch style: a case per state that has actions; both parameters are cast to void when no state has any.
        def(`static void OnEntry(${M}* m, ${P}_State state)`, () =>
            sw('state', m.states.filter(s => s.entry.length).map(s => ({ labels: [st(s)], lines: [...s.entry.map(a => `${call(a)};`), 'break;'] })), ['break;'], ['m', 'state'])
        );
        def(`static void OnExit(${M}* m, ${P}_State state)`, () =>
            sw('state', m.states.filter(s => s.exit.length).map(s => ({ labels: [st(s)], lines: [...s.exit.map(a => `${call(a)};`), 'break;'] })), ['break;'], ['m', 'state'])
        );
    }

    // ---------------------------------------------------------------- core runtime
    // From here on the code is the same in both styles apart from MarkCompletion, EnterRegion, the deep-history
    // test and the transition lookup, because it only uses the structure queries defined above.
    //
    // Innermost(m, s): follow the first region down from s to the innermost active state (s itself if it is a
    // simple state or None). Used by <P>_Current. Orthogonal states are followed through their first region only.
    def(`static ${P}_State Innermost(const ${M}* m, ${P}_State state)`, () => {
        W.open(`while (state != ${st(null)} && RegionsOf(state) > 0 && m->active[FirstRegionOf(state)] != ${st(null)})`);
        W.line('state = m->active[FirstRegionOf(state)];');
        W.close();
        W.line('return state;');
    });
    // Completion events. A simple state completes as soon as it has been entered; a composite completes when
    // its region reaches a final state, an orthogonal state when all of its regions have. Completion is only
    // recorded here (pending[owner] = true, from EnterDefault or EnterHistory when a leaf is entered) and
    // processed later by RunCompletions, once the transition that caused it has finished.
    if (m.completion) {
        if (orthogonal) {
            // True if every region of `state` currently sits in a final state. A region that has not been entered
            // yet holds None, which IsFinalState rejects, so an orthogonal state cannot complete while it is
            // still being entered region by region.
            def(`static bool AllRegionsFinal(const ${M}* m, ${P}_State state)`, () => {
                W.line('size_t region;');
                W.open('for (region = FirstRegionOf(state); region < FirstRegionOf(state) + RegionsOf(state); ++region)');
                W.open('if (!IsFinalState(m->active[region]))');
                W.line('return false;');
                W.close();
                W.close();
                W.line('return true;');
            });
        }
        // MarkCompletion(m, leaf): raise the completion event that entering `leaf` causes, if any (see
        // completionOwner). The owner is the leaf itself or the parent of a final leaf; for a parent with
        // several regions all of them must be final.
        def(`static void MarkCompletion(${M}* m, ${P}_State state)`, () => {
            if (table) {
                // `owner == state` short-circuits the region check for simple states that complete on entry.
                // For a single-region parent AllRegionsFinal is trivially true (its region holds the final leaf).
                W.line(`const ${P}_State owner = kCompletion[state];`);
                W.open(`if (owner != ${st(null)}${orthogonal ? ' && (owner == state || AllRegionsFinal(m, owner))' : ''})`);
                W.line('m->pending[owner] = true;');
                W.close();
            } else {
                // Switch style: the owner is resolved per leaf at generation time (MarkCompletion is never called
                // for composites), and the run-time check of all regions is only emitted for orthogonal owners.
                const cases: { labels: string[]; lines: string[] }[] = [];
                for (const s of m.states.filter(x => x.regions.length === 0)) {
                    const owner = completionOwner(m, s);
                    if (!owner) {
                        continue;
                    }
                    if (owner === s || owner.regions.length === 1) {
                        cases.push({ labels: [st(s)], lines: [`m->pending[${st(owner)}] = true;`, 'break;'] });
                    } else {
                        cases.push({ labels: [st(s)], lines: [`if (AllRegionsFinal(m, ${st(owner)}))`, `    m->pending[${st(owner)}] = true;`, 'break;'] });
                    }
                }
                sw('state', cases, ['break;'], ['m', 'state']);
            }
        });
    }
    // Whether the history pseudostate of a history transition's target is deep (see EnterDown): the table style
    // reads kHistoryKind; the switch style uses a constant when all history pseudostates are of one kind and
    // otherwise IsDeepHistory, a switch over the deep ones.
    let deepTest = 'kHistoryKind[state] == 2';
    if (hasHistory && !table) {
        const deep = historyStates.filter(s => s.history === 'deep');
        deepTest = deep.length === 0 ? 'false' : deep.length === historyStates.length ? 'true' : 'IsDeepHistory(state)';
        if (deepTest === 'IsDeepHistory(state)') {
            def(`static bool IsDeepHistory(${P}_State state)`, () => sw('state', [{ labels: deep.map(st), lines: ['return true;'] }], ['return false;']));
        }
    }
    // ExitState(m, s): exit s and everything active below it, innermost first. Order: exit the active state of
    // each own region recursively, last region first (the reverse of the entry order), then for s itself: Trace,
    // cancel its timers, run its exit actions, and clear its region slot. With history pseudostates s is then
    // recorded as the state last exited from its region (m->history, read by EnterHistory), and with orthogonal
    // states it becomes m->exited; since the exit root's call finishes last, m->exited ends up holding the
    // outermost state the transition exited. The reverse loop uses the `region-- > first` idiom because `region`
    // is an unsigned size_t: for a simple state (first = 0, count = 0) a conventional `region >= first` test
    // could never become false, whereas this form tests before decrementing and runs zero times.
    def(`static void ExitState(${M}* m, ${P}_State state)`, () => {
        W.line('size_t region;');
        W.open('for (region = FirstRegionOf(state) + RegionsOf(state); region-- > FirstRegionOf(state);)');
        W.open(`if (m->active[region] != ${st(null)})`);
        W.line('ExitState(m, m->active[region]);');
        W.close();
        W.close();
        L(trace('Exit', `${P}_StateName(state)`));
        if (hasTimers) {
            W.line('CancelTimers(m, state);');
        }
        W.line('OnExit(m, state);');
        W.line(`m->active[RegionOf(state)] = ${st(null)};`);
        if (hasHistory) {
            W.line('m->history[RegionOf(state)] = state;');
        }
        if (orthogonal) {
            W.line('m->exited = state;');
        }
    });
    // EnterState(m, s): enter the single state s. It is marked active before its Trace and entry actions, so
    // hooks already see it as active; its timers start after its entry actions.
    def(`static void EnterState(${M}* m, ${P}_State state)`, () => {
        W.line('m->active[RegionOf(state)] = state;');
        L(trace('Enter', `${P}_StateName(state)`));
        W.line('OnEntry(m, state);');
        if (hasTimers) {
            W.line('StartTimers(m, state);');
        }
    });
    // EnterRegion(m, r): default entry of region r of a composite: the initial transition's actions, then its
    // target, which may be nested several levels below the owner (hence EnterDown). Region 0 (the top level) is
    // never entered through here; Start does it.
    def(`static void EnterRegion(${M}* m, size_t region)`, () => {
        if (table && !m.regions.some(r => r.owner)) {
            // No composite states, so no kRegions table; EnterDefault still refers to this function.
            W.line('(void)m;');
            W.line('(void)region;');
        } else if (table) {
            W.open('if (kRegions[region - 1].action != NULL)');
            W.line('kRegions[region - 1].action(m);');
            W.close();
            W.line(`${enterDown('kRegions[region - 1].owner', 'kRegions[region - 1].initial', 'false')};`);
        } else {
            sw(
                'region',
                m.regions
                    .filter(r => r.owner)
                    .map(r => ({
                        labels: [String(r.index)],
                        lines: [...r.initial!.actions.map(a => `${call(a)};`), `${enterDown(st(r.owner), st(r.initial!.target), 'false')};`, 'break;']
                    })),
                ['break;'],
                ['m', 'region']
            );
        }
    });
    // EnterDefault(m, s): complete the entry of an already entered state s: a composite enters each of its
    // regions by default, in order; a leaf has been fully entered, so this is where its completion is raised.
    def(`static void EnterDefault(${M}* m, ${P}_State state)`, () => {
        W.line('size_t region;');
        W.open('for (region = FirstRegionOf(state); region < FirstRegionOf(state) + RegionsOf(state); ++region)');
        W.line('EnterRegion(m, region);');
        W.close();
        if (m.completion) {
            W.open('if (RegionsOf(state) == 0)');
            W.line('MarkCompletion(m, state);');
            W.close();
        }
    });
    // EnterHistory(m, s, deep): complete the entry of s, which has just been entered through its history
    // pseudostate (or, with `deep`, as part of a deep restoration): every own region re-enters the state last
    // exited from it (m->history), followed by that state's default entry (shallow) or, recursively, by its own
    // recorded regions (deep, which restores every region of nested orthogonal states too). A region without a
    // record (s has not been exited since Start) is entered by default; a leaf may complete, as in EnterDefault.
    if (hasHistory) {
        def(`static void EnterHistory(${M}* m, ${P}_State state, bool deep)`, () => {
            W.line('size_t region;');
            W.open('for (region = FirstRegionOf(state); region < FirstRegionOf(state) + RegionsOf(state); ++region)');
            W.line(`const ${P}_State remembered = m->history[region];`);
            W.open(`if (remembered == ${st(null)})`);
            W.line('EnterRegion(m, region);');
            W.chain('else if (deep)');
            W.line('EnterState(m, remembered);');
            W.line('EnterHistory(m, remembered, true);');
            W.chain('else');
            W.line('EnterDown(m, state, remembered, false);');
            W.close();
            W.close();
            if (m.completion) {
                W.open('if (RegionsOf(state) == 0)');
                W.line('MarkCompletion(m, state);');
                W.close();
            }
        });
    }
    // EnterDown(m, from, target[, history]): the full entry half of a transition: every state from below `from`
    // down to `target`, outermost first, then the entry of `target` by default (EnterDefault) or, for a history
    // transition, from its recorded history (EnterHistory). It works one level at a time: walk up from `target`
    // to the state just below `from` (`state`, and `next`, the one below it on the path, or None), enter `state`
    // and continue from there. With orthogonal states the regions of `state` are entered in order: the region
    // containing `next` along the path, the others by default. Regions that are already active (ancestors at
    // or above `from`) are not touched. `from` must be a proper ancestor of `target` or None (the top level).
    def(`static void EnterDown(${M}* m, ${P}_State from, ${P}_State target${hasHistory ? ', bool history' : ''})`, () => {
        W.line(`${P}_State state = target;`);
        W.line(`${P}_State next = ${st(null)};`);
        if (orthogonal) {
            W.line('size_t region;');
        }
        W.open(`while (${P}_ParentOf(state) != from)`);
        W.line('next = state;');
        W.line(`state = ${P}_ParentOf(state);`);
        W.close();
        W.line('EnterState(m, state);');
        W.open(`if (next == ${st(null)})`);
        if (hasHistory) {
            W.open('if (history)');
            W.line(`EnterHistory(m, state, ${deepTest});`);
            W.line('return;');
            W.close();
        }
        W.line('EnterDefault(m, state);');
        W.line('return;');
        W.close();
        if (orthogonal) {
            W.open('for (region = FirstRegionOf(state); region < FirstRegionOf(state) + RegionsOf(state); ++region)');
            W.open('if (region == RegionOf(next))');
            W.line(`${enterDown('state', 'target', 'history')};`);
            W.chain('else');
            W.line('EnterRegion(m, region);');
            W.close();
            W.close();
        } else {
            W.line(`${enterDown('state', 'target', 'history')};`);
        }
    });

    // Choice points: one function per transition into a choice point, returning true if a branch path fired and
    // false if none was enabled (only emitted when no `[else]` path guarantees success). The incoming
    // transition's own guard is not part of it; the caller tests it first. Both styles call these functions.
    for (const t of compound) {
        W.line(`/* ${t.kind === 'completion' ? 'Completion of' : `Event ${t.event} in`} ${t.source.name}: choice point. */`);
        def(`static bool ${fireName(t)}(${M}* m)`, () => {
            emitBranches(t, t.branches!, t.actions);
            if (!isExhaustive(t.branches!)) {
                W.line('return false;');
            }
        });
    }

    // ---------------------------------------------------------------- transition lookup
    // HandleEvent(m, s, e): try the transitions whose source is exactly s for event e, in model order: per
    // source, transitions that may not fire (guarded, or with a non-exhaustive choice) come before the one that
    // always fires, so the unguarded transition acts as the fallback. The first enabled one fires and the result
    // is true; the parents of s are tried by DispatchState, not here.
    if (table) {
        W.line(`typedef bool (*GuardFn)(${M}* m);`);
        W.line('');
        // Build one TransitionRow initialiser per transition, defining the Guard_<n> / Transition_<n> wrappers it
        // refers to on the way (n = index in m.transitions). The optional columns exist only if some transition
        // needs them, so the struct stays as small as the machine allows.
        const rows = m.transitions.map((t, i) => {
            let guardRef = 'NULL';
            if (t.guard) {
                guardRef = `Guard_${i}`;
                def(`static bool Guard_${i}(${M}* m)`, () => W.line(`return ${guardCall(t, t.event)};`));
            }
            // A choice point performs its actions itself (Fire_<n>), so it gets no action wrapper.
            let action = 'NULL';
            if (!t.branches && t.actions.length) {
                action = `Transition_${i}`;
                def(`static void Transition_${i}(${M}* m)`, () => t.actions.forEach(a => W.line(`${call(a, t.event)};`)));
            }
            // target is None for internal transitions (TryRow's marker for "actions only") and for choice points
            // (whose targets are inside Fire_<n>). lca is unused for both.
            const cells = [st(t.source), ev(t.event), guardRef, action, t.internal || t.branches ? st(null) : st(t.target), st(t.lca)];
            if (hasHistory) {
                cells.push(t.history ? 'true' : 'false');
            }
            if (compound.length) {
                cells.push(t.branches ? fireName(t) : 'NULL');
            }
            // A choice row has no trace name: Fire_<n> traces the branch actually taken.
            if (m.trace) {
                cells.push(t.branches ? 'NULL' : transitionName(t));
            }
            return `{ ${cells.join(', ')} }`;
        });
        // Without transitions there is no table at all (zero-length arrays are not valid C), and HandleEvent
        // below degenerates to `return false`.
        if (rows.length) {
            W.open('typedef struct');
            W.line(`${P}_State source;`);
            W.line(`${P}_Event event;`);
            W.line('GuardFn guard;');
            W.line('Handler action;');
            W.line(`${P}_State target;   /* None for internal transitions */`);
            W.line(`${P}_State lca;`);
            if (hasHistory) {
                W.line('bool history;       /* enter target through its history */');
            }
            if (compound.length) {
                W.line('GuardFn fire;       /* choice point: performs the whole transition */');
            }
            if (m.trace) {
                W.line('const char* name;');
            }
            W.close('} TransitionRow;');
            W.line('');
            // Column legend above the table, matching the struct members present.
            const columns = ['source', 'event', 'guard', 'action', 'target', 'least common ancestor'];
            if (hasHistory) {
                columns.push('history');
            }
            if (compound.length) {
                columns.push('choice');
            }
            if (m.trace) {
                columns.push('trace name');
            }
            W.line(`/* ${columns.join(', ')} */`);
            W.open(`static const TransitionRow kTransitions[${rows.length}] =`);
            rows.forEach(r => W.line(`${r},`));
            W.close('};');
            W.line('');
            // TryRow(m, row): fire one row if its guard holds; the table-driven equivalent of emitTransition.
            // The checks are ordered: guard, then choice point (which does its own tracing, exit and entry), then
            // internal transition (target None), then the external case. The exit root is the ancestor of the
            // source whose parent is the LCA, found by walking up at run time. Defined with `pub` because it is
            // static but defined right before its only caller, so it needs no prototype.
            pub(`static bool TryRow(${M}* m, const TransitionRow* row)`, () => {
                W.open('if (row->guard != NULL && !row->guard(m))');
                W.line('return false;');
                W.close();
                if (compound.length) {
                    W.open('if (row->fire != NULL)');
                    W.line('return row->fire(m);');
                    W.close();
                }
                L(trace('Transition', 'row->name'));
                if (hasInternal) {
                    W.open(`if (row->target == ${st(null)})`);
                    W.open('if (row->action != NULL)');
                    W.line('row->action(m);');
                    W.close();
                    W.line('return true;');
                    W.close();
                }
                W.line(`${P}_State root = row->source;`);
                W.open(`while (${P}_ParentOf(root) != row->lca)`);
                W.line(`root = ${P}_ParentOf(root);`);
                W.close();
                W.line('ExitState(m, root);');
                W.open('if (row->action != NULL)');
                W.line('row->action(m);');
                W.close();
                // With history, EnterDown restores the target's recorded configuration (as in emitEnter).
                W.line(`${enterDown('row->lca', 'row->target', 'row->history')};`);
                W.line('return true;');
            });
        }
        // Linear scan of the whole table; the first matching row whose guard holds wins. A row that is skipped
        // (guard false, or a choice point with no enabled path) lets the scan continue with the next one.
        def(`static bool HandleEvent(${M}* m, ${P}_State state, ${P}_Event event)`, () => {
            if (!rows.length) {
                W.line('(void)m;');
                W.line('(void)state;');
                W.line('(void)event;');
                W.line('return false;');
                return;
            }
            W.line('size_t i;');
            W.open(`for (i = 0; i < ${rows.length}; ++i)`);
            W.open('if (kTransitions[i].source == state && kTransitions[i].event == event && TryRow(m, &kTransitions[i]))');
            W.line('return true;');
            W.close();
            W.close();
            W.line('return false;');
        });
    } else {
        // Switch style: `switch (state)` over the states that are the source of some transition, each with a
        // `switch (event)` over its events (in event order) and the transitions expanded inline.
        def(`static bool HandleEvent(${M}* m, ${P}_State state, ${P}_Event event)`, () => {
            const sources = m.states.filter(s => m.transitions.some(t => t.source === s));
            if (sources.length === 0) {
                W.line('(void)m;');
                W.line('(void)state;');
                W.line('(void)event;');
                W.line('return false;');
                return;
            }
            W.open('switch (state)');
            for (const s of sources) {
                W.line(`case ${st(s)}:`);
                W.indent();
                W.open('switch (event)');
                const own = m.transitions.filter(t => t.source === s);
                for (const e of m.events.filter(e => own.some(t => t.event === e))) {
                    W.line(`case ${ev(e)}:`);
                    W.indent();
                    // `fires` records whether the case ends in a transition that always fires, i.e. in an
                    // unconditional `return`; only otherwise is a closing `break;` needed (and reachable).
                    let fires = false;
                    for (const t of own.filter(t => t.event === e)) {
                        // A guarded transition is wrapped in `if (guard) { ... }`; when the guard fails control
                        // falls through to the next candidate.
                        if (t.guard) {
                            W.open(`if (${guardCall(t, e)})`);
                        }
                        if (t.branches) {
                            // Choice point: an exhaustive one always fires, otherwise a failed path falls through
                            // to the next transition for the event.
                            if (alwaysFires(t)) {
                                W.line(`return ${fireName(t)}(m);`);
                            } else {
                                W.open(`if (${fireName(t)}(m))`);
                                W.line('return true;');
                                W.close();
                            }
                        } else {
                            emitTransition(t);
                        }
                        if (t.guard) {
                            W.close();
                        }
                        // Anything after a transition that always fires would be dead code. model.ts reports a
                        // diagram error for two such transitions with the same source and event, and sorts the
                        // one that always fires last, so this normally only ends the loop early.
                        if (alwaysFires(t)) {
                            fires = true;
                            break;
                        }
                    }
                    if (!fires) {
                        W.line('break;');
                    }
                    W.dedent();
                }
                W.line('default:');
                W.indent();
                W.line('break;');
                W.dedent();
                W.close();
                W.line('break;');
                W.dedent();
            }
            W.line('default:');
            W.indent();
            W.line('break;');
            W.dedent();
            W.close();
            W.line('return false;');
        });
    }

    // ---------------------------------------------------------------- run to completion
    // RunCompletions(m): process raised completion events until none is left, before the public call returns
    // and before any queued event. It repeatedly takes the pending state with the lowest index (pre-order, so
    // outer states before inner ones) and clears its flag. The completion event is offered only to that state
    // (HandleEvent, no bubbling to its ancestors), and only if the state is still active: an earlier completion
    // transition may have left it, which makes the flag stale. If no completion transition is enabled (all
    // guards false) the completion is simply discarded. Firing a completion transition may raise new
    // completions, which the next iteration picks up. model.ts rejects cycles of unguarded completion
    // transitions; a guarded cycle runs for as long as its guards stay true (the engine, which drives the
    // simulator, gives up after a fixed number of completions instead).
    if (m.completion) {
        def(`static void RunCompletions(${M}* m)`, () => {
            W.open('for (;;)');
            W.line('size_t index = 0;');
            W.open(`while (index < ${P}_StateCount && !m->pending[index])`);
            W.line('++index;');
            W.close();
            W.open(`if (index == ${P}_StateCount)`);
            W.line('return;');
            W.close();
            W.line('m->pending[index] = false;');
            W.open(`if (m->active[RegionOf((${P}_State)index)] == (${P}_State)index)`);
            W.line(`HandleEvent(m, (${P}_State)index, ${ev(COMPLETION_EVENT)});`);
            W.close();
            W.close();
        });
    }
    // DispatchState(m, s, e): hierarchical dispatch. Inner states take priority: the event goes to the active
    // state of each of s's regions first (recursively, so it reaches the innermost states first), and s itself
    // only gets it if no region handled it. With orthogonal regions several regions can handle the same event in
    // one step; but once a transition taken in one region has exited s, the remaining regions are not asked, even
    // when the transition entered s again (the fresh regions must not see the same event twice). m->exited, the
    // outermost state exited by the latest transition, tells: s was exited iff m->exited is s or an ancestor of
    // s. A transition that exits a state makes every DispatchState level up to that state return at once, so
    // when this is checked m->exited belongs to a transition taken in the region just asked. Without orthogonal
    // states there is at most one region and the first handled event ends the loop.
    W.line('/* Offers the event to every active region below `state` first, then to `state` itself. */');
    def(`static bool DispatchState(${M}* m, ${P}_State state, ${P}_Event event)`, () => {
        if (orthogonal) {
            W.line('bool handled = false;');
            W.line(`${P}_State s;`);
        }
        W.line('size_t region;');
        W.open('for (region = FirstRegionOf(state); region < FirstRegionOf(state) + RegionsOf(state); ++region)');
        W.open(`if (m->active[region] != ${st(null)} && DispatchState(m, m->active[region], event))`);
        if (orthogonal) {
            W.line('handled = true;');
            W.line('/* Stop if the transition exited `state`, even if it entered it again. */');
            W.open(`for (s = state; s != ${st(null)}; s = ${P}_ParentOf(s))`);
            W.open('if (s == m->exited)');
            W.line('return true;');
            W.close();
            W.close();
        } else {
            W.line('return true;');
        }
        W.close();
        W.close();
        W.line(orthogonal ? 'return handled || HandleEvent(m, state, event);' : 'return HandleEvent(m, state, event);');
    });
    // DispatchCore(m, e): one run-to-completion step without locking or queue handling, shared by the public
    // dispatch functions and DrainQueue. The event starts at the top-level active state; before Start there is
    // none and every event is ignored. Completions run only if the event was handled, since only a transition
    // can raise them. A timeout event disarms its timer first, whichever way it was dispatched (timers are
    // one-shot), and with orthogonal states m->exited is cleared for the step (see DispatchState).
    def(`static bool DispatchCore(${M}* m, ${P}_Event event)`, () => {
        if (hasTimers) {
            W.line('const int timer = TimerIndex(event);');
            W.open('if (timer >= 0)');
            W.line('m->timerArmed[timer] = false;   /* a timer fires once */');
            W.close();
        }
        if (orthogonal) {
            W.line(`m->exited = ${st(null)};`);
        }
        L(trace('Event', `${P}_EventName(event)`));
        W.open(`if (m->active[0] != ${st(null)} && DispatchState(m, m->active[0], event))`);
        if (m.completion) {
            W.line('RunCompletions(m);');
        }
        W.line('return true;');
        W.close();
        L(trace('Ignored', `${P}_EventName(event)`));
        W.line('return false;');
    });
    // ---------------------------------------------------------------- event queue
    // A ring buffer stored in the machine: `queueHead` is the oldest entry, `queueCount` the number of entries.
    if (m.queue) {
        // Appends a copy of `entry`; false (and the event is dropped) when the buffer is full.
        def(`static bool Enqueue(${M}* m, const ${P}_QueuedEvent* entry)`, () => {
            W.open(`if (m->queueCount == ${P}_QueueCapacity)`);
            W.line('return false;');
            W.close();
            W.line(`m->queue[(m->queueHead + m->queueCount) % ${P}_QueueCapacity] = *entry;`);
            W.line('++m->queueCount;');
            W.line('return true;');
        });
        // Dispatches queued events in FIFO order until the queue is empty, including events posted by hooks while
        // draining. Each entry is copied out and removed before it is dispatched, so the slot can be reused by a
        // Post from within that dispatch, and `m->args` points at the copy's union (every member of a union
        // starts at its address, so the cast in the hook calls finds the right struct).
        def(`static void DrainQueue(${M}* m)`, () => {
            W.open('while (m->queueCount > 0)');
            W.line(`const ${P}_QueuedEvent entry = m->queue[m->queueHead];`);
            W.line(`m->queueHead = (m->queueHead + 1) % ${P}_QueueCapacity;`);
            W.line('--m->queueCount;');
            if (hasArgs) {
                W.line('m->args = &entry.args;');
            }
            W.line('DispatchCore(m, entry.event);');
            if (hasArgs) {
                W.line('m->args = NULL;');
            }
            W.close();
        });
    }
    /**
     * Condition (`event != A && event != B ...`) that is true for events the untyped Dispatch/Post accept, or ''
     * if every event is accepted. See `rejected` in info().
     */
    const rejectedCheck = () => {
        if (rejected.length) {
            return `${rejected.map(e => `event != ${ev(e)}`).join(' && ')}`;
        }
        return '';
    };

    // ---------------------------------------------------------------- public API
    // Init: bind hooks and context and put every member into a defined state. No hook is called, so Init does not
    // lock. It is the only place where the timer generations are reset (Start only ever increases them).
    pub(`void ${P}_Init(${M}* m, const ${P}_Hooks* hooks, void* context)`, () => {
        W.line('size_t i;');
        W.line('m->hooks   = hooks;');
        W.line('m->context = context;');
        W.open(`for (i = 0; i < ${P}_RegionCount; ++i)`);
        W.line(`m->active[i] = ${st(null)};`);
        if (hasHistory) {
            W.line(`m->history[i] = ${st(null)};`);
        }
        W.close();
        if (orthogonal) {
            W.line(`m->exited = ${st(null)};`);
        }
        if (m.completion) {
            W.open(`for (i = 0; i < ${P}_StateCount; ++i)`);
            W.line('m->pending[i] = false;');
            W.close();
        }
        if (hasTimers) {
            W.open(`for (i = 0; i < ${P}_TimerCount; ++i)`);
            W.line('m->timerGeneration[i] = 0;');
            W.line('m->timerArmed[i]      = false;');
            W.close();
        }
        if (m.queue) {
            W.line('m->queueHead  = 0;');
            W.line('m->queueCount = 0;');
        }
        if (hasArgs) {
            W.line('m->args = NULL;');
        }
    });
    // Start: a full reset, then the initial entry. The reset cancels every armed timer (CancelTimer hook, and a
    // new generation so that a timeout still on its way is stale) and clears the configuration, the history,
    // pending completions and the queue. It is a reset, not a transition: the states active before are not
    // exited, so no exit actions run. Then the actions of the top-level initial transition run and its target
    // is entered from the top level. Like a dispatch, Start then runs the completions raised on the way (e.g. a
    // Boot state with a completion transition) and the events posted by the entry actions.
    pub(`void ${P}_Start(${M}* m)`, () => {
        W.line('size_t i;');
        L(lock());
        // One block per timer (the timer helpers are switches in both styles, so there is no timer table).
        for (const x of m.timers) {
            W.open(`if (m->timerArmed[${x.index}])`);
            W.line(`m->timerArmed[${x.index}] = false;`);
            W.line(`++m->timerGeneration[${x.index}];`);
            W.line(`m->hooks->CancelTimer(m->context, ${ev(x.event)});`);
            W.close();
        }
        W.open(`for (i = 0; i < ${P}_RegionCount; ++i)`);
        W.line(`m->active[i] = ${st(null)};`);
        if (hasHistory) {
            W.line(`m->history[i] = ${st(null)};`);
        }
        W.close();
        if (m.completion) {
            W.open(`for (i = 0; i < ${P}_StateCount; ++i)`);
            W.line('m->pending[i] = false;');
            W.close();
        }
        if (m.queue) {
            W.line('m->queueHead  = 0;');
            W.line('m->queueCount = 0;');
        }
        L(trace('Start', `"${m.name}"`));
        m.initial.actions.forEach(a => W.line(`${call(a)};`));
        W.line(`${enterDown(st(null), st(m.initial.target), 'false')};`);
        if (m.completion) {
            W.line('RunCompletions(m);');
        }
        if (m.queue) {
            W.line('DrainQueue(m);');
        }
        L(unlock());
    });
    /** Tail shared by all public dispatch functions: forget the arguments, then process the posted events. */
    const finish = () => {
        if (hasArgs) {
            W.line('m->args = NULL;');
        }
        if (m.queue) {
            W.line('DrainQueue(m);');
        }
    };
    // Untyped dispatch. Events with parameters (which would leave `args` NULL) and the internal Completion
    // event are refused: the function returns false without dispatching or tracing anything. Timeout events
    // are accepted here too (to drive timeouts by hand); they bypass the generation check of DispatchTimeout
    // but disarm the timer just the same (DispatchCore).
    pub(`bool ${P}_Dispatch(${M}* m, ${P}_Event event)`, () => {
        W.line('bool handled = false;');
        L(lock());
        const check = rejectedCheck();
        if (check) {
            W.open(`if (${check})`);
        }
        if (hasArgs) {
            W.line('m->args = NULL;');
        }
        W.line('handled = DispatchCore(m, event);');
        finish();
        if (check) {
            W.close();
        }
        L(unlock());
        W.line('return handled;');
    });
    // Typed dispatch per event with parameters: the arguments are copied into a struct on this function's stack
    // and `m->args` points at it while the event (and its completions) are processed; it is reset before the
    // queue is drained, since queued events carry their own arguments.
    for (const e of paramEvents) {
        const ps = m.params.get(e)!;
        pub(`bool ${P}_Dispatch${e}(${M}* m, ${ps.map(p => p.decl).join(', ')})`, () => {
            W.line('bool handled;');
            W.line(`${P}_${e}Args args;`);
            ps.forEach(p => W.line(`args.${p.name} = ${p.name};`));
            L(lock());
            W.line('m->args = &args;');
            W.line(`handled = DispatchCore(m, ${ev(e)});`);
            finish();
            L(unlock());
            W.line('return handled;');
        });
    }
    // Timeout dispatch: only accepted for a timeout event whose timer is still armed with the same generation
    // that StartTimer reported. Anything else (cancelled, restarted, already dispatched, or not a timeout event
    // at all) is ignored and returns false. Dispatching the timeout disarms the timer (DispatchCore), so a timer
    // fires at most once per start. TimerIndex is a pure function and is evaluated before taking the lock.
    if (hasTimers) {
        pub(`bool ${P}_DispatchTimeout(${M}* m, ${P}_Event timeout, unsigned generation)`, () => {
            W.line('bool handled = false;');
            W.line('const int index = TimerIndex(timeout);');
            L(lock());
            W.open('if (index >= 0 && m->timerArmed[index] && m->timerGeneration[index] == generation)');
            if (hasArgs) {
                W.line('m->args = NULL;');
            }
            W.line('handled = DispatchCore(m, timeout);');
            finish();
            W.close();
            L(unlock());
            W.line('return handled;');
        });
    }
    // Post functions: queue an event (with a copy of its arguments) for processing after the current step. They
    // neither lock nor dispatch, because they are meant to be called from hooks, which run inside a dispatch and
    // under the lock. The untyped Post refuses the same events as Dispatch.
    if (m.queue) {
        pub(`bool ${P}_Post(${M}* m, ${P}_Event event)`, () => {
            W.line(`${P}_QueuedEvent entry;`);
            const check = rejectedCheck();
            if (check) {
                W.open(`if (!(${check}))`);
                W.line('return false;');
                W.close();
            }
            W.line('entry.event = event;');
            W.line('return Enqueue(m, &entry);');
        });
        for (const e of paramEvents) {
            const ps = m.params.get(e)!;
            pub(`bool ${P}_Post${e}(${M}* m, ${ps.map(p => p.decl).join(', ')})`, () => {
                W.line(`${P}_QueuedEvent entry;`);
                W.line(`entry.event = ${ev(e)};`);
                ps.forEach(p => W.line(`entry.args.${e}.${p.name} = ${p.name};`));
                W.line('return Enqueue(m, &entry);');
            });
        }
    }
    /**
     * Defines a read-only public query returning `expr`; with threadSafe the value is computed under the lock
     * into a local and returned after unlocking.
     */
    const query = (type: string, signature: string, expr: string) =>
        pub(`${type} ${signature}`, () => {
            if (m.threadSafe) {
                W.line(`${type} result;`);
                L(lock());
                W.line(`result = ${expr};`);
                L(unlock());
                W.line('return result;');
            } else {
                W.line(`return ${expr};`);
            }
        });
    query(`${P}_State`, `${P}_Current(const ${M}* m)`, 'Innermost(m, m->active[0])');
    query('bool', `${P}_IsIn(const ${M}* m, ${P}_State state)`, `state != ${st(null)} && m->active[RegionOf(state)] == state`);
    // Finished = a top-level final state is active. Without top-level final states the answer is always false;
    // the comma expression keeps `m` used so that -Wextra does not complain about an unused parameter.
    query('bool', `${P}_IsFinished(const ${M}* m)`, topFinals.length ? topFinals.map(s => `m->active[0] == ${st(s)}`).join(' || ') : '((void)m, false)');

    // Preamble: banner, the header include and the collected prototypes, followed by the body.
    const w = new Writer(false);
    w.line(`/* ${m.name}: ${style}-based hierarchical state machine generated by MachinaState (C99). Do not edit by hand. */`);
    w.line(`#include "${m.name}.h"`);
    w.line('');
    w.line('/* Internal functions */');
    prototypes.forEach(p => w.line(p));
    w.line('');
    return w.toString() + W.toString();
}
