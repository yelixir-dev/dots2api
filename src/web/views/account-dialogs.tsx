import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ExternalLink, PlugZap } from "lucide-react";
import type { Account, CredentialField, ProviderId } from "../../contracts";
import { ConfirmDialog, Drawer } from "../components/dialog";
import { LoadError } from "../components/domain";
import { Button, Field, Notice, SecretArea, SecretInput, SkeletonRows } from "../components/ui";
import type { NoticeTone } from "../components/ui";
import { runCheck } from "../lib/actions";
import type { AccountEditor } from "../lib/actions";
import { toApiError } from "../lib/api";
import { isHttpUrl, providerName, shortId } from "../lib/format";
import { gateway, useGateway } from "../lib/store";
import { notify } from "../lib/toast";

type SaveMode = "save" | "save-check";
type TextMap = Readonly<Record<string, string>>;

const LABEL_MAX = 80;

interface CredentialInputProps {
  readonly field: CredentialField;
  readonly value: string;
  readonly error: string | null;
  readonly editing: boolean;
  readonly onChange: (value: string) => void;
}

function CredentialInput({ field, value, error, editing, onChange }: CredentialInputProps) {
  const placeholder = editing ? "변경하지 않음" : undefined;
  return (
    <Field label={field.label} mark={editing ? null : field.required ? "required" : "optional"} hint={field.help || undefined} error={error}>
      {(control) => {
        const shared = { ...control, name: field.key, value, placeholder };
        if (field.secret && field.multiline) return <SecretArea {...shared} rows={4} onChange={(event) => onChange(event.target.value)} />;
        if (field.secret) return <SecretInput {...shared} onChange={(event) => onChange(event.target.value)} />;
        if (field.multiline) {
          return <textarea {...shared} className="input input--area" rows={4} spellCheck={false} onChange={(event) => onChange(event.target.value)} />;
        }
        return (
          <input
            {...shared}
            className="input"
            type="text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      }}
    </Field>
  );
}

export function AccountDrawer({ editor, onClose }: { readonly editor: AccountEditor; readonly onClose: () => void }) {
  const { providers, accounts } = useGateway();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [providerChoice, setProviderChoice] = useState<ProviderId | null>(editor.mode === "create" ? editor.provider : editor.account.provider);
  const [label, setLabel] = useState(editor.mode === "edit" ? editor.account.label : "");
  const [values, setValues] = useState<TextMap>({});
  const [labelError, setLabelError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<TextMap>({});
  const [message, setMessage] = useState<{ readonly tone: NoticeTone; readonly text: string } | null>(null);
  const [saving, setSaving] = useState<SaveMode | null>(null);

  const providerList = providers.data ?? [];
  const selectedId = providerChoice ?? providerList[0]?.id ?? null;
  const provider = providerList.find((item) => item.id === selectedId) ?? null;
  const current = editor.mode === "edit" ? (accounts.data?.find((item) => item.id === editor.account.id) ?? null) : null;
  const gone = editor.mode === "edit" && accounts.data !== null && current === null;
  const busy = current?.busy ?? false;
  const blocked = saving !== null || provider === null || gone || busy;

  function chooseProvider(id: ProviderId): void {
    setProviderChoice(id);
    setValues({});
    setFieldErrors({});
    setMessage(null);
  }

  async function save(mode: SaveMode): Promise<void> {
    if (blocked || provider === null) return;
    const trimmedLabel = label.trim();
    const nextLabelError = !trimmedLabel ? "라벨을 입력하세요." : trimmedLabel.length > LABEL_MAX ? `${LABEL_MAX}자 이하로 입력하세요.` : null;
    const credentials: Record<string, string> = {};
    const nextFieldErrors: Record<string, string> = {};
    for (const field of provider.fields) {
      const value = (values[field.key] ?? "").trim();
      if (value) credentials[field.key] = value;
      else if (mode === "save-check" && editor.mode === "create" && field.required) nextFieldErrors[field.key] = "연결 확인에 필요한 항목입니다. 브라우저 로그인은 먼저 빈 계정을 저장하세요.";
    }
    setLabelError(nextLabelError);
    setFieldErrors(nextFieldErrors);
    if (nextLabelError || Object.keys(nextFieldErrors).length > 0) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setMessage(null);
    setSaving(mode);
    try {
      let account: Account;
      if (editor.mode === "create") {
        account = await gateway.createAccount({ provider: provider.id, label: trimmedLabel, credentials });
        notify("ok", `‘${account.label}’ 계정을 추가했습니다`, mode === "save" ? "‘확인’을 눌러 실제 연결을 점검하세요." : null);
      } else {
        const changedLabel = trimmedLabel !== editor.account.label;
        const changedCredentials = Object.keys(credentials).length > 0;
        if (!changedLabel && !changedCredentials) {
          if (mode === "save") {
            setSaving(null);
            setMessage({ tone: "info", text: "변경된 내용이 없습니다." });
            return;
          }
          account = current ?? editor.account;
        } else {
          account = await gateway.updateAccount(editor.account.id, {
            ...(changedLabel ? { label: trimmedLabel } : {}),
            ...(changedCredentials ? { credentials } : {}),
          });
          notify(
            "ok",
            `‘${account.label}’ 계정을 저장했습니다`,
            changedCredentials && mode === "save" ? "자격 증명이 바뀌어 연결 상태가 ‘미연결’로 돌아갔습니다. 다시 확인하세요." : null,
          );
        }
      }
      onClose();
      if (mode === "save-check") void runCheck(account);
    } catch (error) {
      setMessage({ tone: "danger", text: (await toApiError(error)).message });
      setSaving(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void save("save");
  }

  const subtitle =
    editor.mode === "edit"
      ? `${providerName(providers.data, editor.account.provider)} · ${shortId(editor.account.id)}`
      : "공급자를 고르고 자격 증명을 입력하세요.";

  return (
    <Drawer
      title={editor.mode === "create" ? "계정 추가" : "계정 편집"}
      subtitle={subtitle}
      busy={saving !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={saving !== null}>
            취소
          </Button>
          <Button type="submit" form={formId} loading={saving === "save"} disabled={blocked && saving !== "save"}>
            저장
          </Button>
          <Button
            variant="primary"
            icon={<PlugZap aria-hidden="true" />}
            loading={saving === "save-check"}
            disabled={blocked && saving !== "save-check"}
            onClick={() => void save("save-check")}
          >
            저장하고 확인
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className="form" noValidate autoComplete="off" onSubmit={submit}>
        {providers.error && providers.data === null ? <LoadError title="공급자 정보를 불러오지 못했습니다" error={providers.error} /> : null}
        {providers.data === null && !providers.error ? <SkeletonRows count={3} /> : null}
        {providers.data !== null && providerList.length === 0 ? <Notice tone="warn">서버에 등록된 공급자가 없습니다.</Notice> : null}
        {gone ? (
          <Notice tone="warn" title="계정이 삭제되었습니다">
            다른 곳에서 이 계정이 삭제되어 저장할 수 없습니다.
          </Notice>
        ) : null}
        {busy ? (
          <Notice tone="warn" title="계정이 작업 중입니다">
            작업이나 연결 확인이 끝나야 저장할 수 있습니다. 끝나면 이 화면이 자동으로 갱신됩니다.
          </Notice>
        ) : null}

        {editor.mode === "create" && providerList.length > 0 ? (
          <fieldset className="form__section choices">
            <legend className="form__section-title">공급자</legend>
            <div className="choices__list">
              {providerList.map((item) => (
                <label key={item.id} className="choice">
                  <input type="radio" name={`${formId}-provider`} checked={item.id === selectedId} onChange={() => chooseProvider(item.id)} />
                  <span className="choice__body">
                    <span className="choice__title">{item.name}</span>
                    <span className="choice__desc">{item.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <div className="form__section">
          <Field label="라벨" mark={editor.mode === "create" ? "required" : null} error={labelError} hint="목록과 작업 기록에서 이 계정을 구분하는 이름입니다.">
            {(control) => (
              <input
                {...control}
                className="input"
                type="text"
                value={label}
                maxLength={LABEL_MAX}
                placeholder="예: 내 Dot"
                data-autofocus=""
                onChange={(event) => setLabel(event.target.value)}
              />
            )}
          </Field>
        </div>

        {provider ? (
          <section className="form__section" aria-labelledby={`${formId}-credentials`}>
            <div className="form__section-head">
              <h3 className="form__section-title" id={`${formId}-credentials`}>
                자격 증명
              </h3>
              {isHttpUrl(provider.setupUrl) ? (
                <a className="link" href={provider.setupUrl} target="_blank" rel="noreferrer noopener">
                  설정 안내 <ExternalLink aria-hidden="true" />
                </a>
              ) : null}
            </div>
            {editor.mode === "edit" ? (
              <Notice title="저장된 값은 표시되지 않습니다">
                <p>바꿀 항목만 입력하세요. 입력한 항목만 전송되고, 비워 둔 항목은 요청에서 빠지므로 기존 값이 유지됩니다.</p>
                <p>
                  자격 증명을 바꾸면 연결 상태가 ‘미연결’로 돌아가므로 다시 확인해야 합니다.
                  {current && !current.hasCredentials ? " 현재 저장된 자격 증명은 없습니다." : ""}
                </p>
              </Notice>
            ) : null}
            {provider.fields.length === 0 ? (
              <p className="quiet">이 공급자는 입력할 자격 증명이 없습니다.</p>
            ) : (
              provider.fields.map((field) => (
                <CredentialInput
                  key={`${provider.id}:${field.key}`}
                  field={field}
                  value={values[field.key] ?? ""}
                  error={fieldErrors[field.key] ?? null}
                  editing={editor.mode === "edit"}
                  onChange={(value) => setValues((previous) => ({ ...previous, [field.key]: value }))}
                />
              ))
            )}
          </section>
        ) : null}

        <Notice title="연결 확인">
          <p>저장한 뒤 ‘확인’을 누르면 서버가 공급자에 실제로 접속해 그 결과를 계정 상태로 기록합니다.</p>
        </Notice>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      </form>
    </Drawer>
  );
}

export function DeleteAccountDialog({ account, onClose }: { readonly account: Account; readonly onClose: () => void }) {
  const { accounts, providers } = useGateway();
  const current = accounts.data?.find((item) => item.id === account.id) ?? account;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await gateway.deleteAccount(current.id);
      notify("ok", `‘${current.label}’ 계정을 삭제했습니다`);
      onClose();
    } catch (failure) {
      setError((await toApiError(failure)).message);
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog title="계정을 삭제할까요?" confirmLabel="삭제" busy={busy} confirmDisabled={current.busy} onConfirm={() => void confirm()} onClose={onClose}>
      <p>
        <strong className="strong">{current.label}</strong>{" "}
        <span className="muted">
          ({providerName(providers.data, current.provider)} · <span className="mono">{shortId(current.id)}</span>)
        </span>{" "}
        계정과 저장된 자격 증명이 삭제됩니다. 되돌릴 수 없습니다.
      </p>
      {current.busy ? <Notice tone="warn">작업 중인 계정은 삭제할 수 없습니다. 실행 중인 작업이나 확인이 끝난 뒤 다시 시도하세요.</Notice> : null}
      {error ? (
        <Notice tone="danger" title="삭제하지 못했습니다">
          {error}
        </Notice>
      ) : null}
    </ConfirmDialog>
  );
}
