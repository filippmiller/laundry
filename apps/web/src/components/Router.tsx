import { Notice, DemoConfig } from "../types";
import { CustomerWorkspace } from "../workspaces/CustomerWorkspace";
import { CourierWorkspace } from "../workspaces/CourierWorkspace";
import { PartnerWorkspace } from "../workspaces/PartnerWorkspace";
import { DispatcherWorkspace } from "../workspaces/DispatcherWorkspace";
import { AdminWorkspace } from "../workspaces/AdminWorkspace";
import { FinanceWorkspace } from "../workspaces/FinanceWorkspace";
import { SupportClaimsWorkspace } from "../workspaces/SupportClaimsWorkspace";

export function Router({
  me,
  demo,
  setNotice,
}: {
  me: { roles: string[] };
  demo: DemoConfig | null;
  setNotice: (notice: Notice) => void;
}) {
  const roles = me.roles;

  return (
    <>
      {roles.includes("customer") && demo && <CustomerWorkspace demo={demo} notify={setNotice} />}
      {roles.includes("courier") && <CourierWorkspace demo={demo} notify={setNotice} />}
      {(roles.includes("laundry_operator")
        || roles.includes("laundry_supervisor")
        || roles.includes("partner_finance")) && <PartnerWorkspace notify={setNotice} />}
      {roles.includes("dispatcher") && <DispatcherWorkspace notify={setNotice} />}
      {roles.includes("platform_admin") && <AdminWorkspace notify={setNotice} />}
      {roles.includes("platform_finance") && <FinanceWorkspace demo={demo} notify={setNotice} />}
      {(roles.includes("customer_support")
        || roles.includes("claims_approver")
        || roles.includes("claims_investigator")) && (
        <SupportClaimsWorkspace notify={setNotice} roles={roles} />
      )}
      {/* Add others as needed */}
    </>
  );
}
