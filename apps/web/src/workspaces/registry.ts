import type { LucideIcon } from "lucide-react";
import {
  Bike,
  Headset,
  Radio,
  ShieldCheck,
  ShoppingBag,
  WashingMachine,
  Wallet,
} from "lucide-react";

export type WorkspaceKey =
  | "customer"
  | "courier"
  | "partner"
  | "dispatcher"
  | "support"
  | "finance"
  | "admin";

export type WorkspaceDef = {
  key: WorkspaceKey;
  /** Label in the navigation rail. */
  title: string;
  /** Sub-line under the topbar title — what this workspace is for. */
  description: string;
  icon: LucideIcon;
  /** Any one of these session roles unlocks the workspace. */
  roles: string[];
};

/**
 * The single registry of role workspaces. The rail, the router and the
 * topbar all read from this list so a new role only has to be described once.
 */
export const WORKSPACES: readonly WorkspaceDef[] = [
  {
    key: "customer",
    title: "Личный кабинет",
    description: "Заказы, вещи и расчёты",
    icon: ShoppingBag,
    roles: ["customer"],
  },
  {
    key: "courier",
    title: "Смена курьера",
    description: "Маршрут, приёмка и выдача",
    icon: Bike,
    roles: ["courier"],
  },
  {
    key: "partner",
    title: "Прачечная",
    description: "Приёмка, обработка и ОТК",
    icon: WashingMachine,
    roles: ["laundry_operator", "laundry_supervisor", "partner_finance"],
  },
  {
    key: "dispatcher",
    title: "Диспетчерская",
    description: "Рейсы, слоты и расхождения",
    icon: Radio,
    roles: ["dispatcher", "platform_admin"],
  },
  {
    key: "support",
    title: "Поддержка",
    description: "Обращения и претензии",
    icon: Headset,
    roles: ["customer_support", "claims_approver", "claims_investigator"],
  },
  {
    key: "finance",
    title: "Финансы",
    description: "Денежные разрезы платформы",
    icon: Wallet,
    roles: ["platform_finance", "platform_admin"],
  },
  {
    key: "admin",
    title: "Администрирование",
    description: "Участники, роли и аудит",
    icon: ShieldCheck,
    roles: ["platform_admin", "security_auditor"],
  },
];

/** Workspaces the current session may open, in rail order. */
export function workspacesForRoles(roles: string[]): WorkspaceDef[] {
  return WORKSPACES.filter(workspace => workspace.roles.some(role => roles.includes(role)));
}
