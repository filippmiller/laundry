import { lazy, Suspense } from "react";
import { AnimatePresence } from "motion/react";
import { Notice, DemoConfig } from "../types";
import { WorkspaceTransition } from "./ui/Reveal";
import { Skeleton, SkeletonRows } from "./ui/Skeleton";
import type { WorkspaceKey } from "../workspaces/registry";

const CustomerWorkspace = lazy(() =>
  import("../workspaces/CustomerWorkspace").then(m => ({ default: m.CustomerWorkspace })),
);
const CourierWorkspace = lazy(() =>
  import("../workspaces/CourierWorkspace").then(m => ({ default: m.CourierWorkspace })),
);
const PartnerWorkspace = lazy(() =>
  import("../workspaces/PartnerWorkspace").then(m => ({ default: m.PartnerWorkspace })),
);
const DispatcherWorkspace = lazy(() =>
  import("../workspaces/DispatcherWorkspace").then(m => ({ default: m.DispatcherWorkspace })),
);
const AdminWorkspace = lazy(() =>
  import("../workspaces/AdminWorkspace").then(m => ({ default: m.AdminWorkspace })),
);
const FinanceWorkspace = lazy(() =>
  import("../workspaces/FinanceWorkspace").then(m => ({ default: m.FinanceWorkspace })),
);
const SupportClaimsWorkspace = lazy(() =>
  import("../workspaces/SupportClaimsWorkspace").then(m => ({ default: m.SupportClaimsWorkspace })),
);

function WorkspaceSkeleton() {
  return (
    <div className="workspace-grid" role="status" aria-live="polite" aria-label="Загрузка раздела">
      <div className="panel stack">
        <Skeleton variant="title" />
        <SkeletonRows rows={3} />
      </div>
      <div className="panel stack">
        <Skeleton variant="block" />
      </div>
    </div>
  );
}

/**
 * Renders exactly one role workspace at a time. An operator who holds three
 * roles used to see all three workspaces stacked on one page; the rail now
 * owns that choice and the router honours it.
 */
export function Router({
  me,
  demo,
  setNotice,
  activeWorkspace,
}: {
  me: { roles: string[] };
  demo: DemoConfig | null;
  setNotice: (notice: Notice) => void;
  activeWorkspace: WorkspaceKey | null;
}) {
  function workspaceFor(key: WorkspaceKey) {
    switch (key) {
      case "customer":
        return <CustomerWorkspace demo={demo} notify={setNotice} />;
      case "courier":
        return <CourierWorkspace demo={demo} notify={setNotice} />;
      case "partner":
        return <PartnerWorkspace notify={setNotice} roles={me.roles} />;
      case "dispatcher":
        return <DispatcherWorkspace notify={setNotice} roles={me.roles} />;
      case "admin":
        return <AdminWorkspace notify={setNotice} roles={me.roles} />;
      case "finance":
        return <FinanceWorkspace demo={demo} notify={setNotice} roles={me.roles} />;
      case "support":
        return <SupportClaimsWorkspace notify={setNotice} roles={me.roles} />;
      default:
        return null;
    }
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      {activeWorkspace ? (
        <WorkspaceTransition key={activeWorkspace}>
          <Suspense fallback={<WorkspaceSkeleton />}>
            {workspaceFor(activeWorkspace)}
          </Suspense>
        </WorkspaceTransition>
      ) : null}
    </AnimatePresence>
  );
}
