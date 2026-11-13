import { useQuery } from "@tanstack/react-query";
import { signInConfigQuery } from "../access/api";

/** Enum Studio's line mark in currentColor, the same literals as @enum-studio/tokens/mark.svg. */
export function Mark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 19 19"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="0.75"
        y="0.75"
        width="17.5"
        height="17.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect x="3" y="4.5" width="9" height="1.5" fill="currentColor" />
      <rect x="3" y="10" width="5" height="1.5" fill="currentColor" />
    </svg>
  );
}

export function BrandIdentity({ size }: { size: number }) {
  const { data } = useQuery(signInConfigQuery);
  const brand = data?.brand;
  if (brand && (brand.custom || brand.logo_url))
    return (
      <>
        {brand.logo_url && (
          <img
            src={brand.logo_url}
            alt={brand.name}
            className="h-6 max-w-full shrink-0 object-contain"
          />
        )}
        <span className="truncate">{brand.name}</span>
      </>
    );
  return (
    <>
      <Mark size={size} />
      <span className="truncate">Power BI Metrics Book</span>
    </>
  );
}
