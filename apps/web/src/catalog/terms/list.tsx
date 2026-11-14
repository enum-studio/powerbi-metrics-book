import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookText } from "lucide-react";
import { TABLE_BOX, TABLE_HEAD, TABLE_HEADING } from "../../admin/layout/ui";
import { EmptyState, ErrorState, Loading } from "../../shell/states";
import { ItemIcon } from "../../shell/item-icon";
import { termsQuery } from "../queries";
import { Trust } from "../trust";

const WIDE = "hidden sm:table-cell";

export function TermsList() {
  const q = useQuery(termsQuery);
  if (q.isPending) return <Loading what="terms" />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <>
      <h1 className="text-title font-semibold">Terms</h1>
      <p className="mt-1 max-w-(--measure) text-ui text-ink-2">
        The words the business uses, defined once: Returning customer, Sign-up
        attribution, Cohort. A term can point to the columns that hold it and
        the metrics that use it.
      </p>
      {q.data.length === 0 ? (
        <EmptyState title="No terms yet">
          When a curator defines a term, it shows here.
        </EmptyState>
      ) : (
        <div className={`mt-6 ${TABLE_BOX}`}>
          <table className="w-full text-left text-ui">
            <thead className={TABLE_HEAD}>
              <tr>
                <th className={TABLE_HEADING}>Term</th>
                <th className={`${TABLE_HEADING} ${WIDE}`}>Kind</th>
                <th className={`${TABLE_HEADING} text-right ${WIDE}`}>
                  Columns
                </th>
                <th className={TABLE_HEADING}>Trust</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {q.data.map((term) => (
                <tr key={term.name} className="hover:bg-raised">
                  <td className="px-3 py-2.5">
                    <Link
                      to="/catalog/terms/$term"
                      params={{ term: term.name }}
                      className="flex items-start gap-2"
                    >
                      <span className="mt-0.5">
                        <ItemIcon icon={term.icon} fallback={BookText} />
                      </span>
                      <span>
                        <span className="font-medium">{term.name}</span>
                        <span className="block text-meta text-ink-2">
                          {term.summary}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className={`px-3 py-2.5 ${WIDE}`}>
                    {term.type === "dimension" ? "Dimension" : "Concept"}
                  </td>
                  <td
                    className={`px-3 py-2.5 text-right font-mono text-meta ${WIDE}`}
                  >
                    {term.column_count}
                  </td>
                  <td className="px-3 py-2.5">
                    <Trust state={term.trust_state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
