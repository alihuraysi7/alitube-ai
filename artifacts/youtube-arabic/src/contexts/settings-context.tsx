import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { SubtitleSettings, loadSettings, saveSettings } from "@/lib/storage";

interface SettingsContextValue {
  settings: SubtitleSettings;
  update: (patch: Partial<SubtitleSettings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SubtitleSettings>(loadSettings);

  useEffect(() => {
    const handler = () => setSettings(loadSettings());
    window.addEventListener("ali-settings-changed", handler);
    return () => window.removeEventListener("ali-settings-changed", handler);
  }, []);

  function update(patch: Partial<SubtitleSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  }

  return (
    <SettingsContext.Provider value={{ settings, update }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
