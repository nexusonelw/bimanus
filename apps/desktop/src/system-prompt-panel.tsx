import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopAppState, SystemPromptRecord } from "./desktop-state";
import { ArchiveIcon } from "./icons";
import type { PiDesktopApi } from "./ipc";
import { useI18n } from "./i18n";

interface SystemPromptPanelProps {
  readonly api: PiDesktopApi;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    api: PiDesktopApi,
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
}

export function SystemPromptPanel(props: SystemPromptPanelProps) {
  const { api, setSnapshot, updateSnapshot } = props;
  const { t } = useI18n();
  const [prompts, setPrompts] = useState<readonly SystemPromptRecord[]>([]);
  const [activePromptId, setActivePromptId] = useState<string | undefined>(undefined);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptContent, setNewPromptContent] = useState("");
  const [saving, setSaving] = useState(false);
  const activePrompt = prompts.find((prompt) => prompt.id === activePromptId);

  // Load current state on mount
  useEffect(() => {
    void api.getState().then((state) => {
      setPrompts(state.systemPrompts);
      setActivePromptId(state.activeSystemPromptId);
      const active = state.systemPrompts.find((prompt) => prompt.id === state.activeSystemPromptId);
      setNewPromptName(active?.name ?? "");
      setNewPromptContent(active?.content ?? "");
    });
  }, []);

  async function handleSave() {
    if (!newPromptName.trim() || !newPromptContent.trim()) return;
    setSaving(true);
    try {
      await updateSnapshot(api, setSnapshot, () =>
        api.saveSystemPrompt(newPromptName, newPromptContent, activePromptId),
      );
      const state = await api.getState();
      setPrompts(state.systemPrompts);
      setActivePromptId(state.activeSystemPromptId);
      if (!activePromptId) {
        setNewPromptName("");
        setNewPromptContent("");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleSelectChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    const nextId = value === "" ? undefined : value;
    await updateSnapshot(api, setSnapshot, () => api.setActiveSystemPrompt(nextId));
    setActivePromptId(nextId);
    const selected = prompts.find((prompt) => prompt.id === nextId);
    setNewPromptName(selected?.name ?? "");
    setNewPromptContent(selected?.content ?? "");
  }

  async function handleDelete(promptId: string) {
    await updateSnapshot(api, setSnapshot, () => api.deleteSystemPrompt(promptId));
    const state = await api.getState();
    setPrompts(state.systemPrompts);
    setActivePromptId(state.activeSystemPromptId);
    const active = state.systemPrompts.find((prompt) => prompt.id === state.activeSystemPromptId);
    setNewPromptName(active?.name ?? "");
    setNewPromptContent(active?.content ?? "");
  }

  return (
    <aside className="system-prompt-panel">
      <div className="system-prompt-panel__header">
        <h2 className="system-prompt-panel__title">
          {activePrompt ? t("systemPrompt.edit") : t("systemPrompt.title")}
        </h2>
      </div>

      <div className="system-prompt-panel__body">
        <div className="system-prompt-panel__select-row">
          <select
            className="system-prompt-panel__select"
            value={activePromptId ?? ""}
            onChange={handleSelectChange}
            aria-label={t("systemPrompt.select")}
          >
            <option value="">{t("systemPrompt.noneActive")}</option>
            {prompts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {activePromptId ? (
            <button
              className="icon-button system-prompt-panel__delete"
              type="button"
              onClick={() => handleDelete(activePromptId)}
              aria-label={t("systemPrompt.deleteActive")}
              title={t("systemPrompt.delete")}
            >
              <ArchiveIcon />
            </button>
          ) : null}
        </div>

        <div className="system-prompt-panel__form">
          <input
            className="system-prompt-panel__name-input"
            type="text"
            placeholder={t("systemPrompt.namePlaceholder")}
            value={newPromptName}
            onChange={(e) => setNewPromptName(e.target.value)}
            aria-label={t("systemPrompt.nameAria")}
          />
          <textarea
            className="system-prompt-panel__content-input"
            placeholder={t("systemPrompt.contentPlaceholder")}
            value={newPromptContent}
            onChange={(e) => setNewPromptContent(e.target.value)}
            rows={8}
            aria-label={t("systemPrompt.contentAria")}
          />
          <button
            className="button button--primary system-prompt-panel__save"
            type="button"
            disabled={!newPromptName.trim() || !newPromptContent.trim() || saving}
            onClick={handleSave}
          >
            {saving ? t("systemPrompt.saving") : activePrompt ? t("systemPrompt.update") : t("systemPrompt.save")}
          </button>
        </div>
      </div>
    </aside>
  );
}
