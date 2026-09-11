// Mirrors the permission logic in AccessSettingsPage.jsx / navigation.js
// exactly, so a page hidden in the UI is also refused by the API — the
// frontend hides the button, this is what actually stops the operation.

/**
 * The pages a user can see: their own customization if set, otherwise
 * their role's defaults. Matches `currentAllowed()` in
 * AccessSettingsPage.jsx verbatim — including the `null` vs `[]`
 * distinction (see migration 002's comment on `allowed_pages`).
 *
 * @param {{allowed_pages: string[]|null}} user
 * @param {{allowed_tabs: string[], allowed_more: string[]}} role
 */
function currentAllowed(user, role) {
  if (Array.isArray(user.allowed_pages)) return user.allowed_pages;
  if (!role) return [];
  return [...role.allowed_tabs.filter((x) => x !== "more"), ...role.allowed_more];
}

/**
 * Guard against locking the whole branch out of permission management:
 * refuses to remove "access" from the last user in the branch who has it.
 * Translates the `togglePage` guard in AccessSettingsPage.jsx verbatim.
 *
 * @param {Array<{id:string, allowed_pages: string[]|null}>} branchUsers - every user in the branch, with their role's allowed_more/allowed_tabs already resolved into effective pages by the caller
 * @param {string} userId - the user being edited
 * @param {string[]} nextAllowed - the page list they would have after the edit
 */
function wouldLockOutAccess(branchUsersWithAllowed, userId, nextAllowed) {
  const losingAccess = !nextAllowed.includes("access");
  if (!losingAccess) return false;
  const othersWithAccess = branchUsersWithAllowed.filter(
    (u) => u.id !== userId && u.allowed.includes("access")
  );
  return othersWithAccess.length === 0;
}

/**
 * Guard against deleting the last manager in a branch. Translates the
 * `remove()` guard in AccessSettingsPage.jsx verbatim:
 *   `users.filter(u => u.role === "manager").length <= 1 && target.role === "manager"`
 */
function wouldRemoveLastManager(branchUsers, userId) {
  const target = branchUsers.find((u) => u.id === userId);
  if (!target || target.role !== "manager") return false;
  const managerCount = branchUsers.filter((u) => u.role === "manager").length;
  return managerCount <= 1;
}

export { currentAllowed, wouldLockOutAccess, wouldRemoveLastManager };
