/**
 * SillyNovel — server plugin
 *
 * Mounted by SillyTavern at /api/plugins/sillynovel (requires
 * `enableServerPlugins: true` in config.yaml).
 *
 * STATUS: scaffold. Only the Phase 1.5 spike routes exist — project/chapter
 * CRUD lands in Phase 4. See docs/PLAN.md.
 *
 * ⚠️ SECURITY (see AGENTS.md — these are not negotiable):
 *  - NEVER reconstruct a user's filesystem path from a session handle. Use the
 *    authenticated `request.user.directories` object ST's middleware provides.
 *    If it is absent, that is a BLOCKER — stop, do not work around it.
 *  - NEVER interpolate route params into a path. Server-generated UUIDs only,
 *    strict validation, and re-check every resolved path stays under the
 *    user's own directory.
 *
 * NOTE: plugin changes require a CONTAINER RESTART (Node loads plugins at
 * boot). Extension changes only need a browser reload.
 */

export const info = {
    id: 'sillynovel',
    name: 'SillyNovel',
    description: 'Project and chapter storage for the SillyNovel Writing Workspace.',
};

/**
 * @param {import('express').Router} router mounted at /api/plugins/sillynovel
 */
export async function init(router) {
    // Liveness check — confirms the plugin loaded and routes are mounted.
    router.get('/health', (_req, res) => {
        res.json({ ok: true, plugin: info.id, version: '0.0.1' });
    });

    /*
     * Phase 1.5 storage spike.
     *
     * Reports whether ST's auth middleware populates `request.user.directories`
     * on plugin routes. Per-user isolation depends entirely on this: if it is
     * missing, the storage design changes — the path handling does not.
     *
     * Returns only booleans and key names, never absolute paths, so the probe
     * itself cannot leak filesystem layout.
     */
    router.get('/spike/user-context', (req, res) => {
        const user = req.user;
        const directories = user?.directories;

        res.json({
            hasUser: Boolean(user),
            hasDirectories: Boolean(directories),
            directoryKeys: directories ? Object.keys(directories) : [],
            // Blocker condition — see docs/PLAN.md Phase 1.5.
            blocked: !directories,
        });
    });

    console.log('[sillynovel] server plugin loaded (scaffold)');
}

export async function exit() {
    console.log('[sillynovel] server plugin unloaded');
}

export default { info, init, exit };
