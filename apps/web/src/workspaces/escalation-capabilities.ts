/**
 * The escalation actions the person in front of the screen may perform.
 *
 * The server opens and closes escalations for dispatcher and platform_admin only
 * (`ROLE_GROUPS.dispatcher` in `src/core/context.ts`); a finance-only operator may read the
 * list, but must not be offered buttons the server would reject. The panel therefore derives
 * its buttons from the session roles instead of guessing. The server keeps its own checks —
 * this only keeps the interface from promising what the backend will not do.
 *
 * The function lives in its own module because it has to be provable without a browser: the
 * repository has no DOM test harness, and a unit test cannot import a `.tsx` module (the root
 * TypeScript project compiles `test/**` without the JSX flag). The panel re-exports it, so
 * `import { escalationCapabilities } from "./ops-panels"` is the single entry point for the
 * workspaces.
 */
export type EscalationCapabilities = {
  canEscalate: boolean;
  canResolve: boolean;
};

export function escalationCapabilities(roles: string[]): EscalationCapabilities {
  const canMutate = roles.some(role => role === "dispatcher" || role === "platform_admin");
  return { canEscalate: canMutate, canResolve: canMutate };
}
