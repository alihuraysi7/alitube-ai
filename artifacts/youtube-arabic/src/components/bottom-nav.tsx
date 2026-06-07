import { useLocation } from "wouter";
import { Home, History, Settings } from "lucide-react";

const TABS = [
  { path: "/",         label: "الرئيسية",  Icon: Home },
  { path: "/history",  label: "السجلات",   Icon: History },
  { path: "/settings", label: "الإعدادات", Icon: Settings },
] as const;

export function BottomNav() {
  const [location, navigate] = useLocation();

  return (
    <nav
      style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        zIndex: 100,
        background: "rgba(11,18,32,0.92)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        display: "flex",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      {TABS.map(({ path, label, Icon }) => {
        const active = location === path;
        return (
          <button
            key={path}
            type="button"
            onClick={() => navigate(path)}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "10px 0 12px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              transition: "all 0.18s",
              color: active ? "#FF3D00" : "#475569",
              fontFamily: "'Cairo', 'Tajawal', sans-serif",
              fontSize: "0.72rem",
              fontWeight: active ? 700 : 500,
            }}
          >
            <Icon
              style={{
                width: 22, height: 22,
                transition: "transform 0.18s",
                transform: active ? "scale(1.15)" : "scale(1)",
              }}
            />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
