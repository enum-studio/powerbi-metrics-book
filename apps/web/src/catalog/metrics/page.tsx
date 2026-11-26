import { MetricDocumentation } from "../guide/documentation";
import { Exports } from "../guide/exports";
import { DocumentationEditor } from "../guide/editor";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError } from "../../api/client";
import type { Me } from "../../api/me";
import { ChartNoAxesColumn, Folder } from "lucide-react";
import { Breadcrumb, Crumb, CrumbName } from "../../shell/breadcrumb";
import { PageIcon } from "../../shell/icon-picker";
import { ItemIcon } from "../../shell/item-icon";
import { EmptyState, ErrorState, Loading } from "../../shell/states";
import { categoriesQuery } from "../queries";
import { categoryTrail, findCategory } from "../tree/model";
import { metricQuery, variantsQuery } from "../../review/queries";
import { AcceptedAnswers } from "../../review/accepted-answers";
import { History } from "../../review/history";
import { Panel } from "../../review/panel";
import { QuestionsSection } from "../../review/questions";
import { TrustState } from "../../review/trust";
import { Variants } from "../../review/variants";
import { formatShift, mayCurate } from "../../review/format";
import { Breakable } from "../../shell/breakable";

export function MetricPage({
  name,
  me,
  variant,
}: {
  name: string;
  me: Me;
  variant?: string;
}) {
  const metric = useQuery(metricQuery(name));
  const categories = useQuery(categoriesQuery);
  const variants = useQuery(variantsQuery(name));
  if (metric.isPending || categories.isPending)
    return <Loading what="the metric" />;
  if (metric.error !== null) {
    if (metric.error instanceof ApiError && metric.error.status === 404)
      return (
        <EmptyState
          title="No such metric"
          action={
            <Link
              to="/catalog"
              className="text-accent underline underline-offset-4 hover:text-accent-hover"
            >
              Go to the start
            </Link>
          }
        >
          There is no metric called {name} that you can see. Check the address
          for a typo, or ask whoever sent you the link.
        </EmptyState>
      );
    return <ErrorState error={metric.error} />;
  }
  if (categories.error !== null) return <ErrorState error={categories.error} />;
  const path = metric.data.category?.path;
  const trail = path === undefined ? [] : categoryTrail(categories.data, path);
  const categoryNames = trail.map((part) =>
    findCategory(categories.data, part),
  );
  const categoryLinks = categoryNames.flatMap((category) =>
    category === undefined
      ? []
      : [{ path: category.path, name: category.name, icon: category.icon }],
  );
  return (
    <>
      <Breadcrumb
        here={metric.data.label}
        icon={
          <ItemIcon
            icon={metric.data.icon}
            fallback={ChartNoAxesColumn}
            size={14}
          />
        }
      >
        <Crumb to="/catalog">Metrics</Crumb>
        {path === undefined && (
          <Crumb to="/catalog" search={{ view: "not-filed" }}>
            Not filed
          </Crumb>
        )}
        {categoryLinks.map((category) => (
          <Crumb
            key={category.path}
            to="/catalog/categories/$"
            params={{ _splat: category.path }}
            title={category.name}
          >
            <CrumbName icon={category.icon} fallback={Folder}>
              {category.name}
            </CrumbName>
          </Crumb>
        ))}
      </Breadcrumb>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-8">
          <header className="flex flex-col gap-2">
            <PageIcon
              kind="metric"
              id={metric.data.id}
              icon={metric.data.icon}
              fallback={ChartNoAxesColumn}
            />
            <h1 className="text-title font-semibold text-ink">
              {metric.data.label}
            </h1>
            <p className="font-mono text-ui text-ink-2">
              <Breakable text={metric.data.name} />
            </p>
            <TrustState metric={metric.data} />
          </header>
          <Exports name={metric.data.name} />
          <MetricDocumentation metric={metric.data} />
          <DocumentationEditor metric={metric.data} me={me} />
          <section
            aria-labelledby="variants-heading"
            className="flex flex-col gap-3"
          >
            <h2
              id="variants-heading"
              className="text-heading font-semibold text-ink"
            >
              Variants
            </h2>
            {variants.isPending ? (
              <p className="text-ui text-ink-3">Loading the variants</p>
            ) : variants.error !== null ? (
              <p role="alert" className="text-ui text-ink-2">
                The variants could not be loaded: {variants.error.message}
              </p>
            ) : (
              <Variants variants={variants.data} currentVariant={variant} />
            )}
            {metric.data.other_variants.length > 0 && (
              <p className="text-meta text-ink-3">
                Also:{" "}
                {metric.data.other_variants
                  .map(
                    ({ shift, count }) =>
                      `${formatShift(shift)} (${String(count)})`,
                  )
                  .join(", ")}
              </p>
            )}
          </section>
          <QuestionsSection metricId={metric.data.id} />
          <AcceptedAnswers answers={metric.data.accepted_answers} />
          {mayCurate(me) && (
            <section
              aria-labelledby="history-heading"
              className="flex flex-col gap-3"
            >
              <h2
                id="history-heading"
                className="text-heading font-semibold text-ink"
              >
                History
              </h2>
              <History name={metric.data.name} categories={categories.data} />
            </section>
          )}
        </div>
        <Panel metric={metric.data} me={me} categoryLinks={categoryLinks} />
      </div>
    </>
  );
}
