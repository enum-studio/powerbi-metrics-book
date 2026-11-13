import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { api, read } from "../../api/client";
import { Notice } from "../../shell/notice";
import { Loading } from "../../shell/states";
import { formatTime } from "../../shell/time";
import { AdminError } from "../layout/admin-layout";
import {
  INPUT,
  LINK,
  PageFrame,
  SectionBox,
  Segmented,
  Switch,
  TABLE_BOX,
  TABLE_HEAD,
  TABLE_HEADING,
} from "../layout/ui";
import { ADMIN_KEY, putSetting, settingQuery } from "../settings/api";

const DATASETS = queryOptions({
  queryKey: [...ADMIN_KEY, "datasets"],
  queryFn: async () => (await read(api.GET("/api/v1/admin/datasets"))).datasets,
  retry: false,
});
type Dataset = Awaited<
  ReturnType<NonNullable<typeof DATASETS.queryFn>>
>[number];
const NEW_DATASETS = "powerbi.datasets.new";
// In a narrow page, the name and its switch: the counts would push the switch out of view.
const COUNT = "hidden @2xl:table-cell";
type NoticeMessage = { message: string; undo?: () => void };

export function DatasetsPage() {
  const client = useQueryClient();
  const datasets = useQuery(DATASETS);
  const setting = useQuery(settingQuery(NEW_DATASETS));
  const [find, setFind] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const dismiss = useCallback(() => {
    setNotice(null);
  }, []);
  const change = useMutation({
    mutationFn: ({
      dataset,
      enabled,
    }: {
      dataset: Dataset;
      enabled: boolean;
    }) =>
      read(
        api.PUT("/api/v1/admin/datasets/{dataset}", {
          params: { path: { dataset: dataset.id } },
          body: { enabled },
        }),
      ),
    onMutate: dismiss,
    onSuccess: (saved, { dataset }) => {
      client.setQueryData(DATASETS.queryKey, (rows) =>
        rows?.map((row) =>
          row.id === saved.id ? { ...row, enabled: saved.enabled } : row,
        ),
      );
      setNotice({
        message: saved.enabled
          ? `${saved.name} is on again. People and agents can find and query it.`
          : `${saved.name} is off. It is gone from the catalog, search and every agent, for everyone.`,
        undo: () => {
          change.mutate({ dataset, enabled: !saved.enabled });
        },
      });
      void client.invalidateQueries({ queryKey: ["catalog"] });
      void client.invalidateQueries({ queryKey: ["metric"] });
      void client.invalidateQueries({ queryKey: DATASETS.queryKey });
    },
    onError: (error) => {
      setNotice({ message: error.message });
    },
  });
  const newState = useMutation({
    mutationFn: (value: string) => putSetting(NEW_DATASETS, value, false),
    onMutate: dismiss,
    onSuccess: (saved) => {
      client.setQueryData(settingQuery(NEW_DATASETS).queryKey, saved);
      setNotice({ message: `New datasets now start ${String(saved.value)}.` });
      void client.invalidateQueries({ queryKey: ADMIN_KEY });
    },
    onError: (error) => {
      setNotice({ message: error.message });
    },
  });
  if (datasets.isError || setting.isError)
    return <AdminError error={datasets.error ?? setting.error} />;
  if (datasets.isPending || setting.isPending)
    return <Loading what="datasets" />;
  const rows = datasets.data.map((row) =>
    change.isPending && change.variables.dataset.id === row.id
      ? { ...row, enabled: change.variables.enabled }
      : row,
  );
  const on = rows.filter((row) => row.enabled).length;
  const visible = rows.filter(
    (row) =>
      row.name.toLocaleLowerCase().includes(find.toLocaleLowerCase()) &&
      (filter === "all" || row.enabled === (filter === "on")),
  );
  const workspaces = [
    ...new Map(
      visible.map((row) => [row.workspace_id, row.workspace_name]),
    ).entries(),
  ];
  return (
    <PageFrame
      title="Datasets"
      lede="A dataset that is off is gone from the catalog, search and every agent, for everyone, admins included, and its queries are refused. The sync keeps reading it, so turning it on again is instant."
    >
      <SectionBox title="New datasets">
        <div className="flex flex-wrap items-center gap-3 text-ui text-ink">
          <p>A dataset the sync finds for the first time starts</p>
          <Segmented
            label="New dataset state"
            value={
              newState.isPending
                ? newState.variables
                : String(setting.data.value)
            }
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            disabled={newState.isPending}
            onChange={(value) => {
              newState.mutate(value);
            }}
          />
        </div>
        <p className="text-meta text-ink-3">
          Off suits a large tenant: nothing new reaches agents until an admin
          turns it on here.
        </p>
      </SectionBox>
      <SectionBox title={`All datasets ${String(rows.length)}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <label className="sr-only" htmlFor="find-dataset">
              Find a dataset
            </label>
            <input
              id="find-dataset"
              className={INPUT}
              placeholder="Find a dataset"
              value={find}
              onChange={(event) => {
                setFind(event.target.value);
              }}
            />
          </div>
          <Segmented
            label="Dataset state"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "on", label: `On ${String(on)}` },
              { value: "off", label: `Off ${String(rows.length - on)}` },
            ]}
          />
        </div>
        <div className={`relative ${TABLE_BOX}`}>
          <table className="w-full text-left text-ui text-ink">
            <thead className={TABLE_HEAD}>
              <tr>
                {["Dataset", "Tables", "Columns", "Measures", "Synced"].map(
                  (heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className={`${TABLE_HEADING} ${heading === "Dataset" ? "" : COUNT}`}
                    >
                      {heading}
                    </th>
                  ),
                )}
                <th scope="col" className={TABLE_HEADING}>
                  <span className="sr-only">State</span>
                </th>
              </tr>
            </thead>
            {workspaces.map(([id, name]) => (
              <tbody key={id}>
                <tr>
                  <th
                    colSpan={6}
                    scope="rowgroup"
                    className="border-t border-line px-3 py-2 text-meta font-normal text-ink-3"
                  >
                    {name} workspace
                  </th>
                </tr>
                {visible
                  .filter((row) => row.workspace_id === id)
                  .map((row) => (
                    <tr key={row.id} className="border-t border-line">
                      <th scope="row" className="px-3 py-2.5 font-medium">
                        {row.enabled ? (
                          <Link
                            to="/catalog/datasets/$id"
                            params={{ id: row.id }}
                            search={{ tab: "diagram", table: undefined }}
                            className={`${LINK} pointer-coarse:inline-flex pointer-coarse:min-h-(--tap) pointer-coarse:min-w-(--tap) pointer-coarse:items-center`}
                          >
                            {row.name}
                          </Link>
                        ) : (
                          <span className="text-ink-3">{row.name}</span>
                        )}
                      </th>
                      {[row.tables, row.columns, row.measures].map(
                        (count, index) => (
                          <td
                            key={index}
                            className={`px-3 py-2.5 font-mono text-meta text-ink-2 ${COUNT}`}
                          >
                            {count}
                          </td>
                        ),
                      )}
                      <td
                        className={`px-3 py-2.5 text-meta whitespace-nowrap text-ink-3 ${COUNT}`}
                      >
                        {row.synced_at === null ? (
                          "Not synced yet"
                        ) : (
                          <time dateTime={row.synced_at}>
                            {formatTime(row.synced_at)}
                          </time>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <Switch
                          label={row.name}
                          checked={row.enabled}
                          disabled={change.isPending}
                          onChange={(enabled) => {
                            change.mutate({ dataset: row, enabled });
                          }}
                        />
                      </td>
                    </tr>
                  ))}
              </tbody>
            ))}
          </table>
          {visible.length === 0 && (
            <p className="py-4 text-ui text-ink-3">No datasets match.</p>
          )}
        </div>
      </SectionBox>
      {notice !== null && <Notice {...notice} onDismiss={dismiss} />}
    </PageFrame>
  );
}
