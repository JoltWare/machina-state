// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Runs the reference engine with hooks that print exactly what the generated-code harness prints.
const path = require('path');
const { Engine } = require(path.join(__dirname, '..', 'out', 'engine.js'));

const TRACE_KINDS = ['Start', 'Event', 'Ignored', 'Transition', 'Exit', 'Enter'];

function paramKind(type) {
    const t = type.replace(/\bconst\b|&|\s/g, '');
    if (/^(int|long|short|unsigned|uint|ulong|ushort|byte|sbyte|std::size_t|size_t|u?int\d+_t|std::u?int\d+_t)$/.test(t)) {
        return 'int';
    }
    if (t === 'bool') {
        return 'bool';
    }
    return /string/i.test(t) ? 'string' : 'other';
}

/** JavaScript value matching the literal the harness passes for parameter `param` in step `i`. */
function value(param, i) {
    switch (paramKind(param.type)) {
        case 'int':
            return i % 7;
        case 'bool':
            return i % 2 === 1;
        case 'string':
            return `s${i}`;
        default:
            return undefined;
    }
}

function printed(param, v) {
    switch (paramKind(param.type)) {
        case 'int':
        case 'string':
            return ` ${v}`;
        case 'bool':
            return v ? ' true' : ' false';
        default:
            return '';
    }
}

/**
 * Deterministic event script shared by all variants of one machine: the directed events first, then pseudo-random
 * ones. Every third random timeout is sent through DispatchTimeout with a generation that is never valid
 * (`stale`), every third one through DispatchTimeout with the generation of the timer's latest StartTimer
 * (`valid`), and the rest with a plain Dispatch. With `options.restart` a `{ restart: true }` step (Start is
 * called again) is inserted halfway through the random part.
 */
function script(machine, steps, directed = [], options = {}) {
    const events = machine.events.filter(e => e !== 'Completion');
    let seed = 12345;
    const result = directed.map((event, i) => {
        const params = machine.params.get(event) ?? [];
        return { event, params, typed: params.length > 0, stale: false, valid: false, i };
    });
    const start = result.length;
    for (let i = start; i < start + steps && events.length; i++) {
        if (options.restart && i === start + Math.floor(steps / 2)) {
            result.push({ restart: true, i });
        }
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const event = events[Math.floor(seed / 65536) % events.length];
        const params = machine.params.get(event) ?? [];
        const timer = machine.timers.find(t => t.event === event);
        const stale = timer !== undefined && i % 3 === 0;
        const valid = timer !== undefined && i % 3 === 1;
        result.push({ event, params, typed: params.length > 0 && i % 5 !== 0, stale, valid, i });
    }
    return result;
}

/** Event posted from every fourth action call when the queue is enabled (null if the machine has no plain event). */
function postedEvent(machine) {
    return machine.queue ? machine.events.find(e => e !== 'Completion' && (machine.params.get(e) ?? []).length === 0) ?? null : null;
}

/** Events of all scenarios recorded in a diagram, in order. */
function scenarioEvents(diagram) {
    return (diagram.scenarios ?? []).flatMap(s => s.steps.map(step => step.event));
}

function runEngine(machine, steps, options = {}) {
    let out = '';
    let counter = 0;
    let posts = 0;
    const posted = options.posted !== undefined ? options.posted : postedEvent(machine);
    const hookParams = name => machine.hookParams.get(name) ?? [];
    // Generation of the latest StartTimer per timeout event, for the `valid` DispatchTimeout steps.
    const generations = new Map();
    const engine = new Engine(machine, {
        guard(name, args) {
            const result = ++counter % 3 !== 0;
            out += `  guard ${name}${hookParams(name).map((p, i) => printed(p, args[i])).join('')} -> ${result ? 1 : 0}\n`;
            return result;
        },
        action(name, args) {
            out += `  ${name}${hookParams(name).map((p, i) => printed(p, args[i])).join('')}\n`;
            if (posted && ++posts % 4 === 0) {
                out += `  post ${posted} ${engine.post(posted) ? 1 : 0}\n`;
            }
        },
        trace(kind, name) {
            if (machine.trace) {
                out += `[${kind}] ${name}\n`;
            }
        },
        startTimer(event, ms, generation) {
            generations.set(event, generation);
            out += options.legacy ? `  StartTimer ${event} ${ms}\n` : `  StartTimer ${event} ${ms} ${generation}\n`;
        },
        cancelTimer(event) {
            out += `  CancelTimer ${event}\n`;
        }
    });
    const name = () => engine.current()?.name ?? 'None';
    engine.start();
    out += `-> ${name()}\n`;
    for (const s of script(machine, steps, options.directed, { restart: options.restart })) {
        if (s.restart) {
            engine.start();
            out += `restart -> ${name()}\n`;
            continue;
        }
        const stale = s.stale && !options.legacy;
        const valid = s.valid && !options.legacy;
        const h = stale
            ? engine.dispatchTimeout(s.event, 0)
            : valid
              ? engine.dispatchTimeout(s.event, generations.get(s.event) ?? 0)
              : s.typed
                ? engine.dispatch(s.event, s.params.map(p => value(p, s.i)), true)
                : engine.dispatch(s.event);
        out += `${s.event} ${h ? 1 : 0} -> ${name()} finished=${engine.isFinished() ? 1 : 0}\n`;
    }
    return out;
}

module.exports = { TRACE_KINDS, paramKind, script, scenarioEvents, postedEvent, runEngine };
