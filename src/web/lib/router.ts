import { useMemo, useSyncExternalStore } from "react";
import { jobIdSchema } from "../../contracts";
import type { JobId } from "../../contracts";

// Hash routing keeps every view reachable from the single HTML route the server mounts.
export type Route =
  | { readonly view: "overview" }
  | { readonly view: "accounts" }
  | { readonly view: "jobs"; readonly jobId: JobId | null }
  | { readonly view: "api" };

export type View = Route["view"];

export function parseRoute(hash: string): Route {
  const [section, id] = hash.replace(/^#\/?/, "").split("/");
  switch (section) {
    case "accounts":
      return { view: "accounts" };
    case "jobs": {
      const parsed = jobIdSchema.safeParse(id);
      return { view: "jobs", jobId: parsed.success ? parsed.data : null };
    }
    case "api":
      return { view: "api" };
    default:
      return { view: "overview" };
  }
}

export function routeHref(route: Route): string {
  switch (route.view) {
    case "overview":
      return "#/";
    case "accounts":
      return "#/accounts";
    case "jobs":
      return route.jobId ? `#/jobs/${route.jobId}` : "#/jobs";
    case "api":
      return "#/api";
  }
}

export function navigate(route: Route): void {
  window.location.hash = routeHref(route);
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => parseRoute(hash), [hash]);
}
