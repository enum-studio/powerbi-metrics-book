import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  useStore,
  useStoreApi,
} from "@xyflow/react";
import { EyeOff, KeyRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FOOT,
  HEAD,
  ROW,
  WIDTH,
  boundsOf,
  ends,
  focusOn,
  grid,
  keepVisible,
  layout,
  overflows,
  viewport,
  type Placed,
  type Row,
  type View,
} from "./layout";
import { matchesTerm } from "./find";
import type { Density, DiagramModel, DiagramSelection } from "./model";

/** A table to bring into view, asked for anew each time `asked` changes, so picking the same table twice moves the view twice. */
export type DiagramFocus = { name: string; asked: number } | null;

type Props = {
  model: DiagramModel;
  density: Density;
  selection: DiagramSelection;
  onSelect: (next: DiagramSelection) => void;
  /** The search box's term: tables whose names do not hold it fade. */
  term?: string;
  focus?: DiagramFocus;
};

type TableState = "selected" | "neighbour" | "dimmed" | "plain";
type TableData = {
  name: string;
  rows: Row[];
  foot: string | null;
  state: TableState;
};
type TableNode = Node<TableData, "table">;

const MINIMAP = { width: 140, height: 110 } as const;
/** Long enough for the pane to take its new width when a panel opens beside it. */
const SETTLE_MS = 60;

const tableBorder: Record<TableState, string> = {
  selected: "border-accent outline-2 outline-accent",
  neighbour: "border-accent",
  dimmed: "border-line-strong opacity-45",
  plain: "border-line-strong",
};

const handleClass = "size-0! min-h-0! min-w-0! border-0! bg-transparent!";

function TableBox({ data }: NodeProps<TableNode>) {
  return (
    <div
      className={`rounded border bg-surface ${tableBorder[data.state]}`}
      style={{ width: WIDTH }}
    >
      <div
        className="flex items-center border-b border-line px-3"
        style={{ height: HEAD }}
      >
        <span
          className="min-w-0 flex-1 truncate text-ui font-semibold text-ink"
          title={data.name}
        >
          {data.name}
        </span>
      </div>
      {data.rows.map((row) => (
        <div
          key={row.name}
          className="relative flex items-center gap-1.5 px-3 text-meta"
          style={{ height: ROW }}
        >
          <Handle
            type="target"
            position={Position.Left}
            id={`${row.name}:in`}
            isConnectable={false}
            className={handleClass}
          />
          <span className="w-3 shrink-0 text-ink-3">
            {row.key && (
              <KeyRound size={11} strokeWidth={1.75} aria-label="key" />
            )}
          </span>
          <span
            className={`min-w-0 flex-1 truncate ${row.hidden ? "text-ink-3" : "text-ink-2"}`}
            title={row.name}
          >
            {row.name}
          </span>
          {row.hidden && (
            <EyeOff
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-ink-3"
              aria-label="hidden in Power BI"
            />
          )}
          <span className="shrink-0 font-mono text-label text-ink-3">
            {row.type}
          </span>
          <Handle
            type="source"
            position={Position.Right}
            id={`${row.name}:out`}
            isConnectable={false}
            className={handleClass}
          />
        </div>
      ))}
      {data.foot !== null && (
        <div
          className="border-t border-line px-3 py-1 text-meta text-ink-3"
          style={{ height: FOOT }}
        >
          {data.foot}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { table: TableBox };

/** Where each row's handles sit, so lines can be drawn before React Flow has measured the DOM. */
function handlesFor(rows: Row[]): NonNullable<Node["handles"]> {
  return rows.flatMap((row, i) => {
    const y = 1 + HEAD + i * ROW + ROW / 2;
    return [
      {
        id: `${row.name}:in`,
        type: "target" as const,
        position: Position.Left,
        x: 1,
        y,
        width: 0,
        height: 0,
      },
      {
        id: `${row.name}:out`,
        type: "source" as const,
        position: Position.Right,
        x: WIDTH - 1,
        y,
        width: 0,
        height: 0,
      },
    ];
  });
}

/** Crow's foot for many, a bar for one, in two tones. */
const markerShapes = {
  many: "M1 7 L13 1 M1 7 L13 7 M1 7 L13 13",
  one: "M6 1 L6 13",
} as const;
const markerTones = { plain: "var(--ink-3)", hot: "var(--accent)" } as const;

function Markers() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <defs>
        {Object.entries(markerTones).flatMap(([tone, color]) =>
          Object.entries(markerShapes).map(([end, d]) => (
            <marker
              key={`${end}-${tone}`}
              id={`diagram-${end}-${tone}`}
              viewBox="0 0 14 14"
              refX="13"
              refY="7"
              markerWidth="14"
              markerHeight="14"
              orient="auto-start-reverse"
              markerUnits="userSpaceOnUse"
            >
              <path d={d} stroke={color} strokeWidth="1.25" fill="none" />
            </marker>
          )),
        )}
      </defs>
    </svg>
  );
}

function touching(model: DiagramModel, table: string): number[] {
  const found: number[] = [];
  model.relationships.forEach((r, i) => {
    if (r.from_table === table || r.to_table === table) found.push(i);
  });
  return found;
}

/** The lines a selection or a pointer picks out. */
function pickedBy(model: DiagramModel, pick: DiagramSelection): Set<number> {
  if (pick?.kind === "table") return new Set(touching(model, pick.name));
  if (pick?.kind === "relationship") return new Set([pick.index]);
  return new Set();
}

function Canvas({
  model,
  density,
  selection,
  onSelect,
  term = "",
  focus = null,
}: Props) {
  const placed = useMemo(
    () =>
      model.unknown === null ? layout(model, density) : grid(model, density),
    [model, density],
  );
  const bounds = useMemo(() => boundsOf(placed), [placed]);
  const { setViewport, getViewport } = useReactFlow();
  const store = useStoreApi();
  const paneWidth = useStore((s) => s.width);
  const paneHeight = useStore((s) => s.height);
  const tall =
    paneWidth > 0 &&
    overflows(bounds, { width: paneWidth, height: paneHeight });
  const [hover, setHover] = useState<DiagramSelection>(null);

  // Fit once on arrival, bring a table found by search to the middle, and otherwise only keep the selected table in view.
  const arrived = useRef(false);
  const focused = useRef(0);

  // A search that ends with no table picked puts the view back where it was when it began; after a pick, the view stays on that table.
  const searching = useRef<{ before: View; picked: boolean } | null>(null);
  const active = term.trim() !== "";
  useEffect(() => {
    if (active && searching.current === null)
      searching.current = { before: getViewport(), picked: false };
    if (!active && searching.current !== null) {
      if (!searching.current.picked) void setViewport(searching.current.before);
      searching.current = null;
    }
  }, [active, getViewport, setViewport]);
  useEffect(() => {
    if (focus !== null && searching.current !== null)
      searching.current.picked = true;
  }, [focus]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const { width, height } = store.getState();
      if (width === 0 || height === 0) return;
      if (!arrived.current) {
        arrived.current = true;
        const arrival =
          selection?.kind === "table"
            ? placed.find((p) => p.table.name === selection.name)
            : undefined;
        const rect = arrival && {
          x: arrival.x,
          y: arrival.y,
          width: WIDTH,
          height: arrival.height,
        };
        void setViewport(viewport(bounds, { width, height }, rect));
        return;
      }
      const found =
        focus !== null && focus.asked !== focused.current
          ? placed.find((p) => p.table.name === focus.name)
          : undefined;
      if (focus !== null && found !== undefined) {
        focused.current = focus.asked;
        void setViewport(
          focusOn(
            getViewport(),
            { x: found.x, y: found.y, width: WIDTH, height: found.height },
            { width, height },
          ),
        );
        return;
      }
      if (selection?.kind !== "table") return;
      const selected = placed.find((p) => p.table.name === selection.name);
      if (selected === undefined) return;
      const current = getViewport();
      const next = keepVisible(
        current,
        { x: selected.x, y: selected.y, width: WIDTH, height: selected.height },
        { width, height },
      );
      if (next.x !== current.x || next.y !== current.y) void setViewport(next);
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [
    placed,
    bounds,
    selection,
    focus,
    paneWidth,
    paneHeight,
    setViewport,
    getViewport,
    store,
  ]);

  const selectedLines = useMemo(
    () => pickedBy(model, selection),
    [model, selection],
  );
  const hoveredLines = useMemo(() => pickedBy(model, hover), [model, hover]);
  const neighbours = useMemo(() => {
    const names = new Set<string>();
    for (const i of selectedLines) {
      const r = model.relationships[i];
      if (r) names.add(r.from_table).add(r.to_table);
    }
    return names;
  }, [model, selectedLines]);

  const stateOf = (name: string): TableState => {
    const selected = selection?.kind === "table" && selection.name === name;
    if (!selected && !matchesTerm(name, term)) return "dimmed";
    if (selection === null)
      return hover?.kind === "table" && hover.name === name
        ? "neighbour"
        : "plain";
    if (selected) return "selected";
    return neighbours.has(name) ? "neighbour" : "dimmed";
  };

  // What the person dragged, kept until the model or the density changes the layout.
  const [dragged, setDragged] = useState<{
    of: Placed[];
    nodes: TableNode[];
  } | null>(null);
  const kept = new Map(
    (dragged?.of === placed ? dragged.nodes : []).map((n) => [n.id, n]),
  );
  const nodes: TableNode[] = placed.map((p) => ({
    ...kept.get(p.table.name),
    id: p.table.name,
    type: "table",
    position: kept.get(p.table.name)?.position ?? { x: p.x, y: p.y },
    width: WIDTH,
    height: p.height,
    handles: handlesFor(p.rows),
    data: {
      name: p.table.name,
      rows: p.rows,
      foot: p.foot,
      state: stateOf(p.table.name),
    },
  }));
  const onNodesChange = (changes: NodeChange<TableNode>[]) => {
    setDragged({ of: placed, nodes: applyNodeChanges(changes, nodes) });
  };

  const edges: Edge[] =
    model.unknown !== null
      ? []
      : model.relationships.map((r, i) => {
          const hot = selectedLines.has(i) || hoveredLines.has(i);
          const dimmed =
            !hot &&
            (selection !== null ||
              !matchesTerm(r.from_table, term) ||
              !matchesTerm(r.to_table, term));
          const [from, to] = ends(r.cardinality);
          const tone = hot ? "hot" : "plain";
          return {
            id: String(i),
            source: r.from_table,
            target: r.to_table,
            sourceHandle: `${r.from_column}:out`,
            targetHandle: `${r.to_column}:in`,
            zIndex: hot ? 2 : 0,
            markerStart: `diagram-${from}-${tone}`,
            markerEnd: `diagram-${to}-${tone}`,
            label: !r.is_active
              ? "inactive"
              : r.filters === "both_ways"
                ? "both ways"
                : undefined,
            labelStyle: {
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fill: "var(--ink-3)",
            },
            labelBgStyle: { fill: "var(--bg)" },
            style: {
              stroke: hot ? "var(--accent)" : "var(--ink-3)",
              strokeWidth: hot ? 1.75 : 1.1,
              strokeDasharray: r.is_active ? undefined : "4 4",
              opacity: dimmed ? 0.25 : 1,
            },
          };
        });

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => {
        onSelect({ kind: "table", name: node.id });
      }}
      onEdgeClick={(_, edge) => {
        onSelect({ kind: "relationship", index: Number(edge.id) });
      }}
      onPaneClick={() => {
        onSelect(null);
      }}
      onNodeMouseEnter={(_, node) => {
        setHover({ kind: "table", name: node.id });
      }}
      onNodeMouseLeave={() => {
        setHover(null);
      }}
      onEdgeMouseEnter={(_, edge) => {
        setHover({ kind: "relationship", index: Number(edge.id) });
      }}
      onEdgeMouseLeave={() => {
        setHover(null);
      }}
      onKeyDown={(event) => {
        const target = event.target;
        if (
          event.key === "Enter" &&
          target instanceof HTMLElement &&
          target.classList.contains("react-flow__node")
        ) {
          const name = target.dataset.id;
          if (name !== undefined) onSelect({ kind: "table", name });
        }
      }}
      minZoom={0.2}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      nodesConnectable={false}
      nodesFocusable
      edgesFocusable={false}
      deleteKeyCode={null}
    >
      <Markers />
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      <Controls showInteractive={false} position="bottom-right" />
      {tall && (
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeColor="var(--ink-3)"
          nodeStrokeWidth={0}
          maskColor="var(--scrim)"
          bgColor="var(--surface)"
          style={MINIMAP}
        />
      )}
    </ReactFlow>
  );
}

export function Diagram(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

const legendLine = "shrink-0 text-ink-3";

export function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-meta text-ink-3">
      <span className="flex items-center gap-1.5">
        <svg
          width="28"
          height="14"
          viewBox="0 0 28 14"
          className={legendLine}
          aria-hidden="true"
        >
          <path
            d="M2 7 H26 M2 2 L10 7 M2 12 L10 7 M22 2 V12"
            stroke="currentColor"
            strokeWidth="1.25"
            fill="none"
          />
        </svg>
        many to one
      </span>
      <span className="flex items-center gap-1.5">
        <svg
          width="28"
          height="14"
          viewBox="0 0 28 14"
          className={legendLine}
          aria-hidden="true"
        >
          <path
            d="M2 7 H26"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeDasharray="4 4"
            fill="none"
          />
        </svg>
        inactive
      </span>
      <span className="flex items-center gap-1.5">
        <KeyRound size={11} strokeWidth={1.75} aria-hidden="true" />
        key
      </span>
      <span className="flex items-center gap-1.5">
        <EyeOff size={11} strokeWidth={1.75} aria-hidden="true" />
        hidden in Power BI
      </span>
    </div>
  );
}
