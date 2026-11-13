import { Fragment } from "react";

/**
 * A name such as High_level_fct_order_split, which may break after each
 * underscore and dot, so a narrow screen wraps it between its words and not
 * in the middle of one. A part longer than the line still breaks anywhere.
 */
export function Breakable({ text }: { text: string }) {
  return text.split(/(?<=[_.])/).map((part, index) => (
    <Fragment key={index}>
      {index > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}
