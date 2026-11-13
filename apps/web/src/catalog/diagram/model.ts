export type DiagramTable = {
  name: string;
  description: string | null;
  columns: {
    name: string;
    type: string | null;
    hidden: boolean;
    pii?: boolean;
  }[];
  measures: { name: string; folder: string | null; format?: string | null }[];
};

export type DiagramRelationship = {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  cardinality: string | null; // API form: "many_to_one"
  filters: "one_way" | "both_ways";
  is_active: boolean;
};

export type DiagramModel = {
  tables: DiagramTable[];
  relationships: DiagramRelationship[];
  /** Set when relationships are unknown: the sentence to show, no lines drawn. */
  unknown: string | null;
};

export type Density = "keys" | "all";

export type DiagramSelection =
  | { kind: "table"; name: string }
  | { kind: "relationship"; index: number }
  | null;
