import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { LINK } from "../layout/ui";

/*
 * The guide is the company's own Markdown, written for agents and people.
 * react-markdown builds React elements and never sets HTML, so raw HTML in a
 * guide is shown as text and a script in it does nothing. Images are left
 * out: a guide has no need to make this page fetch a file from elsewhere.
 */
const HEADING = "mt-4 font-semibold text-ink first:mt-0";

/** The props for the DOM: react-markdown also passes `node`, its syntax tree, which would reach the page as an attribute. */
function own<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const rest = { ...props };
  delete rest.node;
  return rest;
}

const COMPONENTS: Components = {
  h1: (props) => <h3 {...own(props)} className={`${HEADING} text-heading`} />,
  h2: (props) => <h4 {...own(props)} className={`${HEADING} text-ui`} />,
  h3: (props) => <h5 {...own(props)} className={`${HEADING} text-ui`} />,
  h4: (props) => <h5 {...own(props)} className={`${HEADING} text-ui`} />,
  h5: (props) => <h5 {...own(props)} className={`${HEADING} text-ui`} />,
  h6: (props) => <h5 {...own(props)} className={`${HEADING} text-ui`} />,
  p: (props) => <p {...own(props)} className="mt-2 first:mt-0" />,
  ul: (props) => <ul {...own(props)} className="mt-2 list-disc pl-5" />,
  ol: (props) => <ol {...own(props)} className="mt-2 list-decimal pl-5" />,
  a: (props) => (
    <a {...own(props)} className={LINK} rel="noreferrer noopener" />
  ),
  code: (props) => (
    <code
      {...own(props)}
      className="rounded bg-raised px-1 font-mono text-meta text-ink"
    />
  ),
  pre: (props) => (
    <pre
      {...own(props)}
      className="mt-2 overflow-x-auto rounded border border-line bg-raised p-3"
    />
  ),
  table: (props) => (
    <div className="mt-2 overflow-x-auto">
      <table {...own(props)} className="min-w-[28rem] text-left text-ui" />
    </div>
  ),
  th: (props) => (
    <th
      {...own(props)}
      className="border-b border-line px-2 py-1 font-medium"
    />
  ),
  td: (props) => <td {...own(props)} className="px-2 py-1 align-top" />,
  img: () => null,
};

export function Guide({ markdown }: { markdown: string }) {
  return (
    <div className="max-w-(--measure) text-ui break-words text-ink-2">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {markdown}
      </Markdown>
    </div>
  );
}
