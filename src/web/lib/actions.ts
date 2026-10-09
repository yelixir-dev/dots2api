import { createContext, use } from "react";
import type { Account, ProviderId } from "../../contracts";
import { toApiError } from "./api";
import { accountStatusLabel } from "./format";
import { gateway } from "./store";
import { notify } from "./toast";

export type AccountEditor =
  | { readonly mode: "create"; readonly provider: ProviderId | null }
  | { readonly mode: "edit"; readonly account: Account };

export type EditorState = AccountEditor | { readonly mode: "connect" } | { readonly mode: "muse-connect" };

export interface ConsoleActions {
  readonly openCreateAccount: (provider?: ProviderId) => void;
  readonly openEditAccount: (account: Account) => void;
  readonly requestDeleteAccount: (account: Account) => void;
}

export const ConsoleActionsContext = createContext<ConsoleActions | null>(null);

export function useConsoleActions(): ConsoleActions {
  const actions = use(ConsoleActionsContext);
  if (!actions) throw new Error("useConsoleActions must be used inside ConsoleActionsContext.");
  return actions;
}

export async function runCheck(account: Account): Promise<void> {
  if (gateway.getSnapshot().checkStartedAt.has(account.id)) return;
  try {
    const checked = await gateway.checkAccount(account.id);
    if (checked.status === "ready") notify("ok", `‘${checked.label}’ 연결 확인됨`, checked.detail || null);
    else notify("danger", `‘${checked.label}’ 연결 확인 실패`, checked.detail || accountStatusLabel[checked.status]);
  } catch (error) {
    notify("danger", `‘${account.label}’ 확인 요청 실패`, (await toApiError(error)).message);
  }
}
