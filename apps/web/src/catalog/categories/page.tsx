import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Folder } from "lucide-react";
import { Breadcrumb, Crumb, CrumbName } from "../../shell/breadcrumb";
import { PageIcon } from "../../shell/icon-picker";
import { ItemIcon } from "../../shell/item-icon";
import { EmptyState, ErrorState, Loading } from "../../shell/states";
import { categoriesQuery } from "../queries";
import { categoryCounts, categoryTrail, findCategory } from "../tree/model";
import { MetricList } from "./metric-list";
import { MetricColumnHeads } from "./metric-row";

export function CategoryPage({ path }: { path: string }) {
  const c = useQuery(categoriesQuery);
  if (c.isPending) return <Loading what="the category" />;
  if (c.error) return <ErrorState error={c.error} />;
  const cats = c.data,
    category = findCategory(cats, path);
  if (!category)
    return (
      <EmptyState
        title="No such category"
        action={
          <Link
            to="/catalog"
            className="text-accent underline underline-offset-4 hover:text-accent-hover"
          >
            Go to the metrics
          </Link>
        }
      >
        There is no category at {path}. Check the address for a typo, or ask
        whoever sent you the link.
      </EmptyState>
    );
  const counts = categoryCounts(cats);
  const trail = categoryTrail(cats, path)
    .map((part) => findCategory(cats, part))
    .filter((x) => x !== undefined);
  return (
    <>
      <Breadcrumb
        here={category.name}
        icon={<ItemIcon icon={category.icon} fallback={Folder} size={14} />}
      >
        <Crumb to="/catalog">Metrics</Crumb>
        {trail.slice(0, -1).map((x) => (
          <Crumb
            key={x.path}
            to="/catalog/categories/$"
            params={{ _splat: x.path }}
            title={x.name}
          >
            <CrumbName icon={x.icon} fallback={Folder}>
              {x.name}
            </CrumbName>
          </Crumb>
        ))}
      </Breadcrumb>
      <PageIcon
        kind="category"
        id={category.id}
        icon={category.icon}
        fallback={Folder}
      />
      <h1 className="text-title font-semibold">{category.name}</h1>
      <p
        className={`mt-1 text-ui ${category.description ? "text-ink-2" : "text-ink-3"}`}
      >
        {category.description ??
          "No description yet. A curator or an agent can write one."}
      </p>
      {category.children.length > 0 && (
        <>
          <h2 className="mt-8 text-heading font-semibold">
            Subcategories {category.children.length}
          </h2>
          <div className="mt-3 divide-y divide-line">
            {category.children.map((x) => (
              <Link
                key={x.path}
                to="/catalog/categories/$"
                params={{ _splat: x.path }}
                className="flex justify-between py-3 hover:bg-raised"
              >
                <span>
                  <b>{x.name}</b>
                  <small className="block text-meta text-ink-2">
                    {x.description}
                  </small>
                </span>
                <span className="font-mono text-label text-ink-3">
                  {counts.get(x.path) ?? 0}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
      <h2 className="mt-8 text-heading font-semibold">
        Metrics {category.metric_count}
      </h2>
      {category.metric_count === 0 ? (
        <p className="mt-3 text-ui text-ink-3">
          {category.children.length > 0
            ? "None filed here directly; they sit in the subcategories."
            : "No metric is filed here yet."}
        </p>
      ) : (
        <div className="mt-3">
          <MetricColumnHeads />
          <MetricList
            filter={{ category: path }}
            total={category.metric_count}
          />
        </div>
      )}
    </>
  );
}
