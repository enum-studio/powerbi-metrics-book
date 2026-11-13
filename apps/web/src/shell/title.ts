import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { signInConfigQuery } from "../access/api";

export function useDocumentTitle(page: string | undefined) {
  const { data } = useQuery(signInConfigQuery);
  const name = data?.brand.name;
  useEffect(() => {
    if (name !== undefined) document.title = page ? `${page} · ${name}` : name;
  }, [name, page]);
}
