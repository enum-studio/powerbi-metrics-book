import {
  BookText,
  ChartNoAxesColumn,
  Database,
  Table2,
  Columns3,
  Folder,
  Sigma,
} from "lucide-react";
import { ItemIcon } from "../../shell/item-icon";
import type { SearchHit } from "./model";

const ICONS = {
  metric: ChartNoAxesColumn,
  term: BookText,
  dataset: Database,
  variant: Sigma,
  table: Table2,
  column: Columns3,
  category: Folder,
} as const;

/** A hit's chosen icon, or the mark the tree shows for its kind. */
export function HitIcon({
  kind,
  icon,
}: {
  kind: SearchHit["kind"];
  icon: string | null;
}) {
  return <ItemIcon icon={icon} fallback={ICONS[kind]} />;
}
