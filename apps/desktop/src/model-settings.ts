import type { ModelSettingsSnapshot, RuntimeSettingsSnapshot, RuntimeSnapshot } from "@bimanus/session-driver/runtime-types";
import type { DesktopAppState, WorkspaceRecord } from "./desktop-state";

export function toModelSettingsSnapshot(settings: RuntimeSettingsSnapshot | ModelSettingsSnapshot): ModelSettingsSnapshot {
  return {
    ...(settings.defaultProvider ? { defaultProvider: settings.defaultProvider } : {}),
    ...(settings.defaultModelId ? { defaultModelId: settings.defaultModelId } : {}),
    ...(settings.defaultThinkingLevel ? { defaultThinkingLevel: settings.defaultThinkingLevel } : {}),
    enabledModelPatterns: [...settings.enabledModelPatterns],
  };
}

export function applyModelSettings(
  runtime: RuntimeSnapshot | undefined,
  modelSettings: ModelSettingsSnapshot | undefined,
): RuntimeSnapshot | undefined {
  if (!runtime) {
    return undefined;
  }
  if (!modelSettings) {
    return runtime;
  }
  return {
    ...runtime,
    settings: {
      ...runtime.settings,
      ...(modelSettings.defaultProvider ? { defaultProvider: modelSettings.defaultProvider } : { defaultProvider: undefined }),
      ...(modelSettings.defaultModelId ? { defaultModelId: modelSettings.defaultModelId } : { defaultModelId: undefined }),
      ...(modelSettings.defaultThinkingLevel
        ? { defaultThinkingLevel: modelSettings.defaultThinkingLevel }
        : { defaultThinkingLevel: undefined }),
      enabledModelPatterns: [...modelSettings.enabledModelPatterns],
    },
  };
}

export function getEffectiveModelRuntime(
  state: Pick<DesktopAppState, "runtimeByWorkspace" | "globalRuntime" | "globalModelSettings">,
  workspace: WorkspaceRecord | undefined,
): RuntimeSnapshot | undefined {
  const runtime = workspace ? state.runtimeByWorkspace[workspace.id] : state.globalRuntime;
  return applyModelSettings(runtime, state.globalModelSettings);
}
