import { useMemo, useState } from "react";
import type { RuntimeSkillRecord, RuntimeSnapshot } from "@bimanus/session-driver/runtime-types";
import type { WorkspaceRecord } from "./desktop-state";
import { RefreshIcon } from "./icons";
import { titleCase } from "./string-utils";
import { useI18n } from "./i18n";

interface SkillsViewProps {
  readonly workspace?: WorkspaceRecord;
  readonly runtime?: RuntimeSnapshot;
  readonly onRefresh: () => void;
  readonly onOpenSkillFolder: (filePath: string) => void;
  readonly onToggleSkill: (filePath: string, enabled: boolean) => void;
  readonly onRemoveSkill: (filePath: string) => Promise<string | undefined>;
  readonly onTrySkill: (skill: RuntimeSkillRecord) => void;
}

export function SkillsView({
  workspace,
  runtime,
  onRefresh,
  onOpenSkillFolder,
  onToggleSkill,
  onRemoveSkill,
  onTrySkill,
}: SkillsViewProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedSkillPath, setSelectedSkillPath] = useState<string | undefined>();
  const [removingSkillPath, setRemovingSkillPath] = useState<string | undefined>();
  const [feedbackMessage, setFeedbackMessage] = useState<string | undefined>();
  const [feedbackTone, setFeedbackTone] = useState<"success" | "error">("success");
  const skills = runtime?.skills ?? [];
  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return skills;
    }

    return skills.filter((skill) =>
      [
        skill.name,
        skill.description,
        skill.source,
        skill.sourceInfo?.scope,
        skill.sourceInfo?.origin,
        skill.slashCommand,
      ].some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [query, skills]);
  const selectedSkill =
    filteredSkills.find((skill) => skill.filePath === selectedSkillPath) ?? filteredSkills[0];
  const selectedSkillCanBeRemoved = selectedSkill ? isRemovableSkill(selectedSkill) : false;

  const handleRemoveSkill = async (skill: RuntimeSkillRecord) => {
    const confirmed = window.confirm(
      t("skills.confirmUninstall", { name: titleCase(skill.name), path: skill.filePath }),
    );
    if (!confirmed) {
      return;
    }

    setRemovingSkillPath(skill.filePath);
    setFeedbackMessage(undefined);
    try {
      const error = await onRemoveSkill(skill.filePath);
      if (error) {
        setFeedbackTone("error");
        setFeedbackMessage(error);
        return;
      }

      setSelectedSkillPath(undefined);
      setFeedbackTone("success");
      setFeedbackMessage(t("skills.uninstalled", { name: titleCase(skill.name) }));
    } finally {
      setRemovingSkillPath(undefined);
    }
  };

  if (!workspace) {
    return (
      <section className="canvas canvas--empty">
        <div className="empty-panel">
          <div className="session-header__eyebrow">{t("skills.eyebrow")}</div>
          <h1>{t("skills.selectWorkspace")}</h1>
          <p>{t("skills.selectWorkspaceDesc")}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="canvas">
      <div className="conversation skills-view">
        <header className="view-header">
          <div>
            <div className="chat-header__eyebrow">{t("skills.eyebrow")}</div>
            <h1 className="view-header__title">{t("skills.title")}</h1>
            <p className="view-header__body">
              {t("skills.headerBody")}
            </p>
          </div>
          <div className="view-header__actions">
            <button className="button button--secondary" type="button" onClick={onRefresh}>
              <RefreshIcon />
              <span>{t("skills.refresh")}</span>
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() =>
                onTrySkill({
                  name: "new-skill",
                  description: t("skills.newSkillDesc"),
                  filePath: "",
                  baseDir: workspace.path,
                  source: "project",
                  sourceInfo: {
                    path: "",
                    source: "project",
                    scope: "project",
                    origin: "top-level",
                    baseDir: workspace.path,
                  },
                  enabled: true,
                  disableModelInvocation: false,
                  slashCommand: "/skill:new-skill",
                })
              }
            >
              {t("skills.newSkill")}
            </button>
          </div>
        </header>

        <div className="skills-toolbar">
          <input
            aria-label={t("skills.search")}
            className="skills-search"
            placeholder={t("skills.search")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          {feedbackMessage ? (
            <div
              className={`extensions-feedback extensions-feedback--${feedbackTone}`}
              role={feedbackTone === "error" ? "alert" : "status"}
            >
              {feedbackMessage}
            </div>
          ) : null}
        </div>

        <div className="skills-layout">
          <div className="skills-grid" data-testid="skills-list">
            {filteredSkills.length === 0 ? (
              <SkillsEmptyState message={t("skills.emptyRefresh")} />
            ) : (
              filteredSkills.map((skill) => (
                <button
                  className={`skill-card ${selectedSkill?.filePath === skill.filePath ? "skill-card--active" : ""}`}
                  key={skill.filePath}
                  type="button"
                  onClick={() => {
                    setSelectedSkillPath(skill.filePath);
                  }}
                >
                  <span className="skill-card__title-row">
                    <span className="skill-card__title">{titleCase(skill.name)}</span>
                    <span className={`skill-card__badge ${skill.enabled ? "skill-card__badge--enabled" : ""}`}>
                      {skill.enabled ? t("skills.enabled") : t("skills.disabled")}
                    </span>
                  </span>
                  <span className="skill-card__description">{skill.description}</span>
                  <span className="skill-card__meta">
                    <span>{skill.sourceInfo?.origin === "package" ? t("skills.scopePackage", { scope: skill.sourceInfo?.scope }) : t("skills.scopeSkill", { scope: skill.sourceInfo?.scope ?? skill.source })}</span>
                    <span>{skill.slashCommand}</span>
                    {skill.disableModelInvocation ? <span>{t("skills.slashOnly")}</span> : null}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="skill-detail">
            {selectedSkill ? (
              <>
                <div className="skill-detail__header">
                  <div>
                    <h2>{titleCase(selectedSkill.name)}</h2>
                    <div className="skill-detail__slash">{selectedSkill.slashCommand}</div>
                  </div>
                  <span className={`skill-detail__status ${selectedSkill.enabled ? "skill-detail__status--enabled" : ""}`}>
                    {selectedSkill.enabled ? t("skills.enabled") : t("skills.disabled")}
                  </span>
                </div>
                <p className="skill-detail__description">{selectedSkill.description}</p>
                <div className="skill-detail__meta-list">
                  <div>
                    <div className="skill-detail__meta-label">{t("skills.source")}</div>
                    <div className="skill-detail__description">{selectedSkill.source}</div>
                  </div>
                  <div>
                    <div className="skill-detail__meta-label">{t("skills.scope")}</div>
                    <div className="skill-detail__description">
                      {selectedSkill.sourceInfo?.origin === "package"
                        ? t("skills.scopePackage", { scope: selectedSkill.sourceInfo?.scope })
                        : t("skills.scopeSkill", { scope: selectedSkill.sourceInfo?.scope ?? selectedSkill.source })}
                    </div>
                  </div>
                  <div>
                    <div className="skill-detail__meta-label">{t("skills.path")}</div>
                    <div className="skill-detail__path">{selectedSkill.filePath}</div>
                  </div>
                </div>
                <div className="skill-detail__actions">
                  <button className="button button--secondary" type="button" onClick={() => onOpenSkillFolder(selectedSkill.filePath)}>
                    {t("skills.openFolder")}
                  </button>
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => onToggleSkill(selectedSkill.filePath, !selectedSkill.enabled)}
                  >
                    {selectedSkill.enabled ? t("skills.disable") : t("skills.enable")}
                  </button>
                  {selectedSkillCanBeRemoved ? (
                    <button
                      className="button button--danger"
                      disabled={removingSkillPath === selectedSkill.filePath}
                      type="button"
                      onClick={() => {
                        void handleRemoveSkill(selectedSkill);
                      }}
                    >
                      {removingSkillPath === selectedSkill.filePath ? t("skills.uninstalling") : t("skills.uninstall")}
                    </button>
                  ) : null}
                  <button className="button button--primary" type="button" onClick={() => onTrySkill(selectedSkill)}>
                    {t("skills.try")}
                  </button>
                </div>
              </>
            ) : (
              <SkillsEmptyState message={t("skills.emptyRuntime")} />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SkillsEmptyState({ message }: { readonly message: string }) {
  const { t } = useI18n();
  return (
    <div className="empty-state">
      <h2>{t("skills.noSkills")}</h2>
      <p>{message}</p>
    </div>
  );
}

function isRemovableSkill(skill: RuntimeSkillRecord): boolean {
  return skill.sourceInfo?.origin === "top-level" && (skill.sourceInfo?.scope === "project" || skill.sourceInfo?.scope === "user");
}

function skillScopeLabel(skill: RuntimeSkillRecord): string {
  if (skill.sourceInfo?.origin === "package") {
    return `${skill.sourceInfo.scope} package`;
  }

  return `${skill.sourceInfo?.scope ?? skill.source} skill`;
}
