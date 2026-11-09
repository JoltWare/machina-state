// Copyright (c) 2026 JoltWare
// SPDX-License-Identifier: Apache-2.0

// Automatic layout of a diagram with the Eclipse Layout Kernel (elkjs: layered, stress and sporeOverlap).
// Containers (the top level, composite states and regions) are laid out bottom-up: each one is a flat
// graph of its direct children, with transitions between nested states lifted to those children.
//
// Used by the "Layout" button / "Auto-Layout Diagram" command (layoutDocument in editorProvider.ts) and by
// the import command (extension.ts), whose PlantUML/SCXML input has no geometry.
//
// Steps of autoLayout:
// 1. Measure, bottom-up (layoutContainer ⇄ measure). Before a container is laid out, each of its children
//    is measured, which first lays out that child's own contents. Pseudostates have fixed sizes, simple
//    states are sized from their text, composite states and regions wrap their laid-out content plus
//    padding. A state with regions stacks them vertically instead of running ELK (any other children of
//    such a state, which analyze rejects, are parked in a row below the regions).
// 2. Lay out each other container with ELK as a flat graph of its direct children. A transition whose ends
//    are nested deeper is "lifted": each end is replaced by the direct child that contains it, so related
//    subtrees are still placed near each other. The graph is arranged three ways (layered left to right,
//    layered top to bottom, organic) and the arrangement closest to a screen-shaped, compact area is kept
//    (score), so a diagram spreads in both directions instead of becoming a long strip. Each child's
//    resulting position is stored relative to the container's content origin (`local`), and so is the ELK
//    route of every edge of a layered arrangement (`routes`).
// 3. Place: walk the tree top-down converting the relative positions into absolute diagram coordinates
//    (the root content starts at MARGIN; a child's content starts at its position plus its padding) and
//    write x/y/w/h back into the states. Regions are then stretched to the full width of their state.
// 4. Bends: convert each ELK route into the `bend` the webview draws with, using the webview's own curve
//    geometry on the final absolute positions (bendThrough). Keep that bend where it is significant;
//    otherwise straighten single transitions and fan out several transitions between the same pair of
//    states so they do not overlap.
//
// ELK computes no geometry for the text itself, and the extension host has no font metrics, so text widths
// are estimated from character counts (textWidth).
import ELK from 'elkjs/lib/elk.bundled.js';
import { Diagram, StateNode, TransitionNode } from './model';

/** Height of one text line (entry/exit/internal transition) under a state's name. */
const LINE = 15;
/** Offset of the top-level content from the diagram origin, on both axes. */
const MARGIN = 40;
/** Padding between a composite state's border and its content (left, right and bottom). */
const PAD = 20;
/** Vertical gap between the stacked orthogonal regions of a state. */
const REGION_GAP = 12;

/** Shared ELK instance. The bundled build runs the layout in-process, without a web worker. */
const elk = new ELK();

/** Gap between the elements parked below the regions of a state (see layoutContainer). */
const PARK_GAP = 40;
/** Largest bend derived from an ELK route, in either direction. */
const MAX_BEND = 250;

/** Preferred width / height of a laid-out container (a landscape screen shape). */
const ASPECT = 1.6;
/** Factor on the score of every arrangement but the first, so that an alternative must be clearly better. */
const ALTERNATIVE_PENALTY = 1.15;
/** Padding around the content of an ELK graph (ELK's default for the root of a graph). */
const ELK_PADDING = 12;
/** Desired length of an edge in the organic arrangement, plus the width of its label. */
const EDGE_LENGTH = 120;
/** Smallest gap between two nodes of the organic arrangement. */
const ORGANIC_GAP = 80;

/**
 * How well a laid-out container of the given size fits on a screen; smaller is better. The area is
 * multiplied by how far the shape is from the `aspect` (width / height) aimed at: 1 for exactly that
 * aspect, 2 for twice as wide or twice as tall. So both wasted space and long strips in either direction
 * count against an arrangement.
 */
function score(w: number, h: number, aspect: number): number {
    const ratio = Math.max(w, 1) / Math.max(h, 1) / aspect;
    return w * h * Math.max(ratio, 1 / ratio);
}

/** A node of the flat graph of one container: a direct child with its measured size. */
interface GraphNode {
    id: string;
    width: number;
    height: number;
}
/** An edge of the flat graph of one container, with the estimated size of its label. */
interface GraphEdge {
    id: string;
    sources: [string];
    targets: [string];
    labels: { text: string; width: number; height: number }[];
}
/**
 * The result of arranging a flat graph: each node's top-left corner and each edge's route (start point,
 * bend points, end point; only from the layered arrangements), relative to the graph's origin, and the
 * size of the graph including ELK_PADDING on every side.
 */
interface Arrangement {
    positions: Map<string, Point>;
    routes: Map<string, Point[]>;
    w: number;
    h: number;
}

/**
 * Arranges a flat graph with ELK's layered algorithm: the flow runs in `direction` (left to right or top
 * to bottom), with the nodes in layers across it and room for the edge labels between the layers. `nodes`
 * are in the order that guides the layering (see layoutContainer).
 */
async function layered(nodes: GraphNode[], edges: GraphEdge[], direction: 'RIGHT' | 'DOWN'): Promise<Arrangement> {
    const result = await elk.layout({
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': direction,
            'elk.spacing.nodeNode': '40',
            'elk.layered.spacing.nodeNodeBetweenLayers': '70',
            'elk.spacing.edgeLabel': '4',
            'elk.edgeLabels.inline': 'false',
            'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
            'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES'
        },
        // Copies: ELK writes its results into the graph it is given.
        children: nodes.map(n => ({ ...n })),
        edges: edges.map(e => ({ ...e, labels: e.labels.map(l => ({ ...l })) }))
    });
    const routes = new Map<string, Point[]>();
    for (const e of result.edges ?? []) {
        const section = e.sections?.[0];
        if (section) {
            routes.set(e.id, [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]);
        }
    }
    return {
        positions: new Map((result.children ?? []).map(n => [n.id, { x: Math.round(n.x ?? 0), y: Math.round(n.y ?? 0) }])),
        routes,
        w: Math.round(result.width ?? 0),
        h: Math.round(result.height ?? 0)
    };
}

/**
 * Arranges a flat graph organically, spread in both directions: ELK's stress algorithm places connected
 * nodes about EDGE_LENGTH plus the label width apart (it ignores the size of the nodes), then ELK's
 * sporeOverlap algorithm pushes overlapping nodes apart until they are at least ORGANIC_GAP apart. The
 * result has no reading direction of its own, so it is mirrored to put the initial pseudostates (`initials`)
 * towards the top left, where a reader starts. There are no edge routes: the transitions are drawn
 * straight.
 */
async function organic(nodes: GraphNode[], edges: GraphEdge[], initials: string[]): Promise<Arrangement> {
    const stressed = await elk.layout({
        id: 'root',
        layoutOptions: { 'elk.algorithm': 'stress' },
        children: nodes.map(n => ({ ...n })),
        edges: edges.map(e => ({
            id: e.id,
            sources: e.sources,
            targets: e.targets,
            layoutOptions: { 'elk.stress.desiredEdgeLength': String(EDGE_LENGTH + (e.labels[0]?.width ?? 0)) }
        }))
    });
    const separated = await elk.layout({
        id: 'root',
        layoutOptions: { 'elk.algorithm': 'sporeOverlap', 'elk.spacing.nodeNode': String(ORGANIC_GAP) },
        children: (stressed.children ?? []).map(c => ({ id: c.id, x: c.x, y: c.y, width: c.width, height: c.height }))
    });
    const boxes = (separated.children ?? []).map(c => ({ id: c.id, x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 }));
    const minX = Math.min(...boxes.map(b => b.x));
    const minY = Math.min(...boxes.map(b => b.y));
    const maxX = Math.max(...boxes.map(b => b.x + b.w));
    const maxY = Math.max(...boxes.map(b => b.y + b.h));
    // Mirror an axis if the initial pseudostates lie, on average, in its far half.
    const starts = boxes.filter(b => initials.includes(b.id));
    const mean = (f: (b: (typeof boxes)[number]) => number) => starts.reduce((sum, b) => sum + f(b), 0) / starts.length;
    const flipX = starts.length > 0 && mean(b => b.x + b.w / 2) > (minX + maxX) / 2;
    const flipY = starts.length > 0 && mean(b => b.y + b.h / 2) > (minY + maxY) / 2;
    return {
        positions: new Map(
            boxes.map(b => [
                b.id,
                {
                    x: Math.round((flipX ? maxX - b.x - b.w : b.x - minX) + ELK_PADDING),
                    y: Math.round((flipY ? maxY - b.y - b.h : b.y - minY) + ELK_PADDING)
                }
            ])
        ),
        routes: new Map(),
        w: Math.round(maxX - minX + 2 * ELK_PADDING),
        h: Math.round(maxY - minY + 2 * ELK_PADDING)
    };
}

/** Estimated width in pixels of `text` at `perChar` pixels per character (8.5 for names, 6.6 for other text). */
const textWidth = (text: string | undefined, perChar: number) => Math.ceil((text ?? '').length * perChar);

/** A point in diagram coordinates. */
export interface Point {
    x: number;
    y: number;
}
/** The geometry of a state as the webview draws it: its kind decides the outline (box or circle). */
export type Shape = Pick<StateNode, 'kind' | 'x' | 'y' | 'w' | 'h'>;

// ------------------------------------------------------------------------------------------------------
// Transition geometry of the webview.
//
// boundaryPoint and transitionFrame are exact ports of boundaryPoint and frame in media/editor.js, and
// curveMidpoint follows its transitionGeometry. They must be kept in step with the webview: a bend is only
// meaningful relative to the way the webview turns it into a curve. test/host.test.js evaluates the
// webview's functions from media/editor.js and fails if the two disagree.
// ------------------------------------------------------------------------------------------------------

/** Centre of a state's bounding box. */
const centre = (s: Shape): Point => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 });

/**
 * Point where the ray from the centre of `s` towards `toward` leaves the outline of `s` (media/editor.js
 * boundaryPoint): real states are rectangles, every other kind a circle of radius w/2; the centre if both
 * points coincide.
 */
export function boundaryPoint(s: Shape, toward: Point): Point {
    const c = centre(s);
    const dx = toward.x - c.x;
    const dy = toward.y - c.y;
    if (dx === 0 && dy === 0) {
        return c;
    }
    if (s.kind !== 'state') {
        const len = Math.hypot(dx, dy);
        const r = s.w / 2;
        return { x: c.x + (dx / len) * r, y: c.y + (dy / len) * r };
    }
    const t = Math.min(dx !== 0 ? s.w / 2 / Math.abs(dx) : Infinity, dy !== 0 ? s.h / 2 / Math.abs(dy) : Infinity);
    return { x: c.x + dx * t, y: c.y + dy * t };
}

/**
 * Straight-line frame of a transition from `s` to `d` (media/editor.js frame): the facing outline points
 * p1/p2, their midpoint and the unit normal n of p1 -> p2 along which a bend is measured.
 */
function transitionFrame(s: Shape, d: Shape) {
    const p1 = boundaryPoint(s, centre(d));
    const p2 = boundaryPoint(d, centre(s));
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = len > 0 ? { x: -(p2.y - p1.y) / len, y: (p2.x - p1.x) / len } : { x: 0, y: -1 };
    return { p1, p2, mid, n };
}

/**
 * The midpoint (t = 0.5) of the curve the webview draws for a transition from `s` to `d` with `bend`: a
 * quadratic Bezier whose control point lies `bend` along the frame's normal from the frame's midpoint, with
 * its end points moved towards the control point when bent (media/editor.js transitionGeometry). This is
 * also where the webview puts the label (beside it, on the outer side of the curve).
 */
export function curveMidpoint(s: Shape, d: Shape, bend: number): Point {
    const f = transitionFrame(s, d);
    const ctrl = { x: f.mid.x + f.n.x * bend, y: f.mid.y + f.n.y * bend };
    const p1 = bend ? boundaryPoint(s, ctrl) : f.p1;
    const p2 = bend ? boundaryPoint(d, ctrl) : f.p2;
    return { x: 0.25 * p1.x + 0.5 * ctrl.x + 0.25 * p2.x, y: 0.25 * p1.y + 0.5 * ctrl.y + 0.25 * p2.y };
}

/**
 * The bend with which the webview's curve from `s` to `d` passes through `p`, as closely as one parameter
 * allows: the curve's midpoint gets the same offset from the frame's midpoint along the normal as `p` (the
 * position along the chord is fixed by the shapes and cannot be chosen).
 *
 * The relation is not linear, because bending also moves the curve's end points round the outlines, so it
 * is solved numerically: the offset of the curve midpoint grows steadily with the bend, and bisection over
 * [-limit, limit] finds the bend to within well under a pixel. Targets beyond what `limit` reaches give
 * ±limit.
 *
 * @param s     Source state, in absolute diagram coordinates.
 * @param d     Target state (different from the source).
 * @param p     The point the curve should pass through, e.g. the midpoint of an ELK route.
 * @param limit Largest bend returned, in either direction.
 * @returns The bend, rounded to a whole number as the webview stores it.
 */
export function bendThrough(s: Shape, d: Shape, p: Point, limit = MAX_BEND): number {
    const { mid, n } = transitionFrame(s, d);
    const goal = (p.x - mid.x) * n.x + (p.y - mid.y) * n.y;
    // Signed distance of the curve midpoint for `bend` beyond the goal, along the normal.
    const excess = (bend: number) => {
        const m = curveMidpoint(s, d, bend);
        return (m.x - mid.x) * n.x + (m.y - mid.y) * n.y - goal;
    };
    let lo = -limit;
    let hi = limit;
    if (excess(lo) >= 0) {
        return -limit;
    }
    if (excess(hi) <= 0) {
        return limit;
    }
    for (let i = 0; i < 40; i++) {
        const m = (lo + hi) / 2;
        if (excess(m) < 0) {
            lo = m;
        } else {
            hi = m;
        }
    }
    return Math.round((lo + hi) / 2);
}

/**
 * The point at half the arc length of a polyline (e.g. an ELK edge route from its start point over its
 * bend points to its end point); the first point if the polyline has no length.
 */
export function polylineMidpoint(points: Point[]): Point {
    const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
    // Walk the segments to the point at half the total length.
    let remaining = lengths.reduce((sum, l) => sum + l, 0) / 2;
    for (let i = 0; i < lengths.length; i++) {
        if (remaining <= lengths[i] && lengths[i] > 0) {
            const f = remaining / lengths[i];
            return { x: points[i].x + (points[i + 1].x - points[i].x) * f, y: points[i].y + (points[i + 1].y - points[i].y) * f };
        }
        remaining -= lengths[i];
    }
    return points[0];
}

/**
 * The parts of a transition's label, one per line as the webview draws them on an arrow
 * (media/editor.js transitionLabelLines). The form depends on the source: from an initial pseudostate only
 * `/ action` (none if there is no action); from a choice point `[guard]` and `/ action`, with `else` for a
 * branch without a guard; otherwise `event`, `[guard]` and `/ action`, leaving out the parts that are empty.
 *
 * @param t      The transition.
 * @param source Its source state, if it exists.
 */
function labelLines(t: TransitionNode, source: StateNode | undefined): string[] {
    const action = (t.action ?? '').trim();
    const actionLine = action ? [`/ ${action}`] : [];
    if (source?.kind === 'initial') {
        return actionLine;
    }
    const guard = (t.guard ?? '').trim();
    if (source?.kind === 'choice') {
        return [`[${guard || 'else'}]`, ...actionLine];
    }
    const event = (t.event ?? '').trim();
    return [...(event ? [event] : []), ...(guard ? [`[${guard}]`] : []), ...actionLine];
}

/** The label of a transition on one line, as the internal-transition lines inside a state show it. */
const label = (t: TransitionNode, source: StateNode | undefined): string => labelLines(t, source).join(' ');

/** Height of one line of a transition label (media/editor.js LABEL_LINE). */
const LABEL_LINE = 13;

/**
 * Lays out the diagram in place and returns it. Sizes of simple states are derived from their text.
 *
 * Overwrites x, y, w and h of every state, sets or removes `bend` on transitions between different states
 * and removes the dragged shape (`loop`) of self transitions, which return to their default place. Names,
 * ids, nesting and all other properties are untouched.
 *
 * @param d The diagram to rearrange (mutated).
 * @returns The same diagram object.
 */
export async function autoLayout(d: Diagram): Promise<Diagram> {
    const byId = new Map(d.states.map(s => [s.id, s]));
    // A state whose parent id does not exist is treated as a top-level state.
    const parentOf = (s: StateNode) => (s.parent && byId.has(s.parent) ? s.parent : null);
    // Direct children of a state, or of the top level when `id` is null.
    const childrenOf = (id: string | null) => d.states.filter(s => parentOf(s) === id);
    // Internal transitions are drawn as text inside the state, not as edges.
    const isInternal = (t: TransitionNode) => t.internal === true && t.source === t.target;
    /** Text lines drawn under the name of a state (entry, exit and internal transitions). */
    const textLines = (s: StateNode): string[] => [
        ...((s.entry ?? '').trim() ? [`entry / ${s.entry!.trim()}`] : []),
        ...((s.exit ?? '').trim() ? [`exit / ${s.exit!.trim()}`] : []),
        ...d.transitions.filter(t => t.source === s.id && isInternal(t)).map(t => label(t, s))
    ];

    // Size of every node, computed bottom-up; containers also record their children's positions.
    const size = new Map<string, { w: number; h: number }>();
    const local = new Map<string, { x: number; y: number }>(); // position relative to the container's content origin
    // Transition id -> its ELK route (start point, bend points, end point), relative to the content origin
    // of `container`, the container in whose graph the edge was laid out.
    const routes = new Map<string, { container: string | null; points: Point[] }>();

    /**
     * Measures the children of a container, arranges them and records their positions in `local`.
     *
     * @param id The container: a state or region id, or null for the top level.
     * @returns The size of the container's content area (excluding the container's own padding).
     */
    async function layoutContainer(id: string | null): Promise<{ w: number; h: number }> {
        const kids = childrenOf(id);
        // Bottom-up: every child's size (and, recursively, its own content layout) is known before this
        // container is arranged.
        for (const k of kids) {
            await measure(k);
        }
        if (kids.length === 0) {
            return { w: 0, h: 0 };
        }
        const owner = id === null ? null : byId.get(id)!;
        // A state with several regions stacks them vertically.
        // All regions get the width of the widest one; ELK is not used for this case.
        // Other children of such a state are invalid (analyze requires every substate of a state with
        // regions to be inside one of them), but they still need a position: they are parked side by side
        // in a row below the regions, top-aligned, inside the state, where they are easy to spot and drag
        // into a region.
        if (owner && owner.kind === 'state' && kids.some(k => k.kind === 'region')) {
            const regions = kids.filter(k => k.kind === 'region');
            const width = Math.max(...regions.map(r => size.get(r.id)!.w));
            let y = 0;
            for (const r of regions) {
                size.get(r.id)!.w = width;
                local.set(r.id, { x: 0, y });
                y += size.get(r.id)!.h + REGION_GAP;
            }
            // `y` is now the top of the parking row (one REGION_GAP below the last region).
            let x = 0;
            let rowHeight = 0;
            for (const k of kids.filter(k => k.kind !== 'region')) {
                local.set(k.id, { x, y });
                x += size.get(k.id)!.w + PARK_GAP;
                rowHeight = Math.max(rowHeight, size.get(k.id)!.h);
            }
            return rowHeight ? { w: Math.max(width, x - PARK_GAP), h: y + rowHeight } : { w: width, h: y - REGION_GAP };
        }
        const ids = new Set(kids.map(k => k.id));
        // Lifts a state to the child of this container that contains it.
        // Walks up the parent chain from `s` (inclusive); undefined if `s` is not inside this container.
        const lift = (s: StateNode): string | undefined => {
            for (let x: StateNode | undefined = s; x; x = x.parent ? byId.get(x.parent) : undefined) {
                if (ids.has(x.id)) {
                    return x.id;
                }
            }
            return undefined;
        };
        // ELK edges for every transition that runs between two different children of this container,
        // after lifting. Transitions that leave the container, internal transitions and transitions inside
        // a single child (handled when that child's content is laid out, or self transitions) are skipped.
        const edges: GraphEdge[] = [];
        for (const t of d.transitions) {
            const s = byId.get(t.source);
            const e = byId.get(t.target);
            if (!s || !e || isInternal(t)) {
                continue;
            }
            const a = lift(s);
            const b = lift(e);
            if (!a || !b || a === b) {
                continue;
            }
            const lines = labelLines(t, s);
            edges.push({
                id: t.id,
                sources: [a],
                targets: [b],
                // Label size estimate so that ELK reserves space for it: the widest line, LABEL_LINE per line.
                labels: lines.length
                    ? [{ text: lines.join('\n'), width: Math.max(...lines.map(x => textWidth(x, 6.6))), height: LABEL_LINE * lines.length + 2 }]
                    : []
            });
        }
        // Breadth-first order from the initial pseudostate, so that cycles are broken against the flow.
        // Children not reachable from an initial pseudostate keep their document order at the end. With the
        // MODEL_ORDER options of the layered arrangement, this order also guides ELK's layering and the order
        // within layers.
        const order: string[] = kids.filter(k => k.kind === 'initial').map(k => k.id);
        for (let i = 0; i < order.length; i++) {
            for (const e of edges) {
                if (e.sources[0] === order[i] && !order.includes(e.targets[0])) {
                    order.push(e.targets[0]);
                }
            }
        }
        kids.filter(k => !order.includes(k.id)).forEach(k => order.push(k.id));
        // Arrange the graph in each of three ways and keep the one that fits a screen best (see score): the
        // layered flow left to right (the default, preferred on a tie) or top to bottom, which suit chains
        // and trees, and the organic arrangement, which spreads a graph with many cycles in both directions
        // instead of stretching it into a long strip. An arrangement that fails is skipped.
        // The regions of a state are stacked vertically, so each of n regions aims at an n times wider shape
        // to keep the whole state near ASPECT.
        const regions = owner?.kind === 'region' ? childrenOf(owner.parent ?? null).filter(r => r.kind === 'region').length : 1;
        const aspect = ASPECT * Math.max(1, regions);
        const nodes = order.map(k => ({ id: k, width: size.get(k)!.w, height: size.get(k)!.h }));
        const initials = kids.filter(k => k.kind === 'initial').map(k => k.id);
        const arrangements = [() => layered(nodes, edges, 'RIGHT'), () => layered(nodes, edges, 'DOWN'), () => organic(nodes, edges, initials)];
        let result: Arrangement | undefined;
        let best = Infinity;
        let failure: unknown;
        for (const [i, arrange] of arrangements.entries()) {
            let candidate: Arrangement;
            try {
                candidate = await arrange();
            } catch (err) {
                failure = err;
                continue;
            }
            const s = score(candidate.w, candidate.h, aspect) * (i === 0 ? 1 : ALTERNATIVE_PENALTY);
            if (s < best) {
                best = s;
                result = candidate;
            }
        }
        if (!result) {
            throw failure;
        }
        result.positions.forEach((p, k) => local.set(k, p));
        // Keep each edge's route for the bend calculation, which needs the final absolute positions of the
        // transition's real end points and therefore runs after placement. Edge coordinates are relative to
        // the same origin as the children's positions.
        result.routes.forEach((points, k) => routes.set(k, { container: id, points }));
        return { w: result.w, h: result.h };
    }

    /**
     * Padding around the content of a container: [left, top, right, bottom].
     * Regions use fixed padding. A state's top padding leaves room for its name (27), one LINE per text line
     * under it, and a gap (18).
     */
    const padding = (s: StateNode): [number, number, number, number] =>
        s.kind === 'region' ? [15, 26, 15, 12] : [PAD, 27 + LINE * textLines(s).length + 18, PAD, PAD];

    /**
     * Computes the size of a state (into `size`), laying out its content first.
     *
     * - initial/final: 24×24; history: 26×26; choice: 30×30 (fixed sizes);
     * - with children (composite state or region): content size plus padding, widened if needed to fit the
     *   name and text lines;
     * - otherwise (simple state, or an empty region): at least 120×60, wide enough for the name and text
     *   lines, with the width rounded to a multiple of 10 and the height grown by LINE per text line.
     */
    async function measure(s: StateNode): Promise<void> {
        const inner = await layoutContainer(s.id);
        if (s.kind === 'initial' || s.kind === 'final') {
            size.set(s.id, { w: 24, h: 24 });
        } else if (s.kind === 'history') {
            size.set(s.id, { w: 26, h: 26 });
        } else if (s.kind === 'choice') {
            size.set(s.id, { w: 30, h: 30 });
        } else if (childrenOf(s.id).length > 0) {
            const [l, t, r, b] = padding(s);
            const titleWidth = textWidth(s.name, 8.5) + 30;
            const linesWidth = Math.max(0, ...textLines(s).map(x => textWidth(x, 6.6) + 20));
            size.set(s.id, { w: Math.max(inner.w + l + r, titleWidth, linesWidth), h: inner.h + t + b });
        } else {
            const lines = textLines(s);
            const w = Math.max(120, textWidth(s.name, 8.5) + 30, ...lines.map(x => textWidth(x, 6.6) + 20));
            size.set(s.id, { w: Math.round(w / 10) * 10, h: lines.length ? Math.max(60, 40 + LINE * lines.length) : 60 });
        }
    }

    // Lay out the whole tree, starting at the top level (recursion via measure).
    await layoutContainer(null);
    // Root content positions are relative to the margin; place every node absolutely.
    // place(container, ox, oy): (ox, oy) is the absolute position of the container's content origin.
    const place = (id: string | null, ox: number, oy: number) => {
        for (const k of childrenOf(id)) {
            const p = local.get(k.id) ?? { x: 0, y: 0 };
            const sz = size.get(k.id)!;
            k.x = ox + p.x;
            k.y = oy + p.y;
            k.w = sz.w;
            k.h = sz.h;
            const [l, t] = padding(k);
            place(k.id, k.x + l, k.y + t);
        }
    };
    place(null, MARGIN, MARGIN);
    // Regions span the full content width of their state.
    // (The state may be wider than its stacked regions, e.g. because of a long name.)
    for (const s of d.states.filter(x => x.kind === 'state')) {
        const regions = d.states.filter(r => r.kind === 'region' && r.parent === s.id);
        const [l, , r] = padding(s);
        regions.forEach(region => (region.w = s.w - l - r));
    }

    // Bends follow the ELK routes: the webview curve of each routed transition is bent so that its midpoint
    // (where the label sits) passes the midpoint of the route, computed with the webview's own geometry on
    // the final absolute positions. For a transition between two direct children of a container the route
    // ends on exactly the states the webview connects; for a lifted transition the route connects their
    // containing children instead, and the curve between the real (nested) end states is bent through the
    // route's midpoint, i.e. through the gap where ELK reserved room for the label. Either way the curve
    // can only match the route at that one point: the route is a polyline that may bend several times,
    // while the webview draws a single quadratic curve, which a bend can only push to one side.
    const routedBend = new Map<string, number>();
    for (const t of d.transitions) {
        const route = routes.get(t.id);
        const s = byId.get(t.source);
        const e = byId.get(t.target);
        if (!route || !s || !e || s === e) {
            continue;
        }
        // Absolute position of the content origin of the container the route was laid out in.
        const owner = route.container === null ? undefined : byId.get(route.container)!;
        const [l, top] = owner ? padding(owner) : [0, 0];
        const ox = owner ? owner.x + l : MARGIN;
        const oy = owner ? owner.y + top : MARGIN;
        const m = polylineMidpoint(route.points);
        routedBend.set(t.id, bendThrough(s, e, { x: ox + m.x, y: oy + m.y }));
    }
    // Straight opposite or parallel transitions are curved apart.
    // A routed bend of at least 12 px is kept. The remaining transitions are grouped by their unordered
    // pair of end states, so that several straight transitions between the same states can be separated.
    const pairs = new Map<string, TransitionNode[]>();
    for (const t of d.transitions) {
        if (t.source === t.target) {
            delete t.loop;
            continue;
        }
        const bend = routedBend.get(t.id) ?? 0;
        if (Math.abs(bend) >= 12) {
            t.bend = bend;
            continue;
        }
        const key = [t.source, t.target].sort().join('|');
        pairs.set(key, [...(pairs.get(key) ?? []), t]);
    }
    for (const list of pairs.values()) {
        // A lone transition is drawn straight.
        if (list.length === 1) {
            delete list[0].bend;
            continue;
        }
        // Opposite directions get the same bend, which curves them to opposite sides.
        // (The webview's normal is taken relative to the transition's direction, so it flips when source and
        // target are swapped.) The spacing grows with the distance between the state centres, minimum 30 px.
        const a = byId.get(list[0].source)!;
        const b = byId.get(list[0].target)!;
        const step = Math.max(30, Math.round(0.08 * Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2)));
        const forward = list.filter(x => x.source === list[0].source);
        const backward = list.filter(x => x.source !== list[0].source);
        if (backward.length === 0) {
            // All in one direction: spread symmetrically around the straight line, i.e. 0, ±2·step, … for
            // an odd count and ±step, ±3·step, … for an even count.
            forward.forEach((t, i) => (t.bend = (2 * i - (forward.length - 1)) * step));
        } else {
            // Both directions: number the transitions of each direction 1, 2, … and bend by that many steps,
            // so each direction fans out on its own side.
            [...forward, ...backward].forEach(t => (t.bend = step * ((t.source === list[0].source ? forward : backward).indexOf(t) + 1)));
        }
    }
    return d;
}
