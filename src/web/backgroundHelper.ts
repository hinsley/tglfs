import {
    HelperRequestError,
    helperRequest,
    parseHelperPairing,
    sealHelperPassword,
    type HelperPairing,
} from "../../packages/tglfs-cli/src/shared/helper-wire"
import { TGLFS_ROOT_PARENT_ID } from "../../packages/tglfs-cli/src/shared/constants"
import { defaultArchiveName } from "../../packages/tglfs-cli/src/shared/archive"
import type { HelperJob } from "../../packages/tglfs-cli/src/helper/protocol"
import { requestText, showToast } from "./dialogs"

type HelperState = { accountId: string; roots: { id: string; name: string }[]; downloadDir: string; jobs: HelperJob[] }
let connection: { pair: HelperPairing; client: any; accountId: string } | null = null
let state: HelperState | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let renderPanel: (() => void) | null = null
let connectionError = ""
const completed = new Set<string>()
const pending = new Map<string, any>()

export function hasBackgroundHelper(client: any): boolean {
    return !!connection && connection.client === client
}
function button(label: string, action: () => void | Promise<void>, primary = false) {
    const element = document.createElement("button")
    element.type = "button"
    element.className = `fx-btn ${primary ? "fx-btn-primary" : "fx-btn-ghost"}`
    element.textContent = label
    element.onclick = () => {
        void Promise.resolve().then(action).catch(reportError)
    }
    return element
}
function text(parent: HTMLElement, tag: string, value: string) {
    const element = document.createElement(tag)
    element.textContent = value
    parent.append(element)
    return element
}
function reportError(error: unknown) {
    showToast(error instanceof Error ? error.message : "The background helper could not complete the request.", "error")
}
function modal(title: string) {
    const prior = document.activeElement as HTMLElement | null
    const backdrop = document.createElement("div")
    backdrop.className = "fx-dialog-backdrop is-open"
    const dialog = document.createElement("div")
    dialog.className = "fx-dialog fx-helper-dialog"
    dialog.setAttribute("role", "dialog")
    dialog.setAttribute("aria-modal", "true")
    const heading = text(dialog, "h2", title)
    heading.id = `helper-${crypto.randomUUID()}`
    dialog.setAttribute("aria-labelledby", heading.id)
    const content = document.createElement("div")
    content.className = "fx-helper-content"
    dialog.append(content)
    const actions = document.createElement("div")
    actions.className = "fx-dialog-actions"
    dialog.append(actions)
    const close = () => {
        backdrop.remove()
        dialog.dispatchEvent(new Event("close"))
        prior?.focus?.()
    }
    actions.append(button("Close", close))
    backdrop.append(dialog)
    document.body.append(backdrop)
    backdrop.addEventListener("keydown", (event) => {
        if ([...document.querySelectorAll(".fx-dialog-backdrop")].at(-1) !== backdrop) return
        if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            dialog.dispatchEvent(new Event("cancel"))
            close()
        }
        if (event.key === "Tab") {
            const items = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, a[href]")]
            if (event.shiftKey && document.activeElement === items[0]) {
                event.preventDefault()
                items.at(-1)?.focus()
            } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
                event.preventDefault()
                items[0]?.focus()
            }
        }
    })
    requestAnimationFrame(() => actions.querySelector("button")?.focus())
    return { dialog, content, actions, close }
}
async function request(path: string, fields?: Record<string, unknown>) {
    const c = connection
    if (!c) throw new Error("Pair with the background helper first.")
    if (String((await c.client.getMe()).id) !== c.accountId)
        throw new Error("The Telegram account changed. Pair with its helper again.")
    return helperRequest(
        c.pair,
        path,
        fields === undefined
            ? undefined
            : { type: "tglfs:helper-request", version: 1, accountId: c.accountId, ...fields },
        { signal: AbortSignal.timeout(15000) },
    )
}
function disconnect() {
    connection = null
    state = null
    pending.clear()
    completed.clear()
    connectionError = ""
    clearTimeout(timer)
    timer = undefined
    updateButton()
    renderPanel?.()
}
function updateButton() {
    const element = document.getElementById("backgroundTransfersButton")
    const count = state?.jobs.filter((j) => ["running", "queued"].includes(j.status)).length ?? 0
    const label = element?.querySelector(".fx-helper-label")
    if (label) label.textContent = `Background transfers${connection ? (count ? ` (${count})` : " · paired") : ""}`
}
async function refresh() {
    const c = connection
    if (!c) return
    try {
        const next: HelperState = await helperRequest(c.pair, "/v1/status", undefined, {
            signal: AbortSignal.timeout(5000),
        })
        if (c !== connection) return
        if (next.accountId !== c.accountId) {
            disconnect()
            throw new Error("The helper Telegram account changed. Pair again.")
        }
        for (const job of next.jobs) {
            if (job.status === "done" && !completed.has(job.id)) {
                completed.add(job.id)
                if (job.direction === "upload") window.dispatchEvent(new Event("tglfs:refresh-browser"))
            }
            pending.delete(job.id)
        }
        state = next
        connectionError = ""
    } catch {
        if (c === connection)
            connectionError =
                "The helper is unreachable. Transfers already accepted may still be running. Reconnect to check; restarting requires unlocking interrupted transfers."
    }
    updateButton()
    renderPanel?.()
    if (c === connection) {
        clearTimeout(timer)
        timer = setTimeout(() => void refresh(), 2000)
    }
}
async function pair(client: any) {
    const code = await requestText({
        title: "Pair background helper",
        message:
            "Start the helper on this computer, then paste its pairing code. Allow local network access if your browser asks.",
        label: "Pairing code",
        inputType: "password",
        confirmLabel: "Pair",
    })
    if (code === null) return
    const pairing = parseHelperPairing(code)
    const next: HelperState = await helperRequest(pairing, "/v1/status", undefined, {
        signal: AbortSignal.timeout(8000),
    })
    const accountId = String((await client.getMe()).id)
    if (next.accountId !== accountId)
        throw new Error(
            "The helper is signed in to a different Telegram account. Sign in to the same account with tglfs login.",
        )
    disconnect()
    connection = { pair: pairing, client, accountId }
    state = next
    next.jobs.filter((j) => j.status === "done").forEach((j) => completed.add(j.id))
    await refresh()
}
async function unlock(job: HelperJob) {
    const password = await requestText({
        title: "Resume background transfer",
        message: job.name,
        label: "Original file password (optional)",
        inputType: "password",
        allowEmpty: true,
        confirmLabel: "Resume",
    })
    if (password === null || !connection) return
    await request("/v1/unlock", {
        id: job.id,
        secret: await sealHelperPassword(password, connection.pair.token, job.id),
    })
    await refresh()
}
async function submit(fields: Record<string, unknown>, password: string) {
    if (!connection) throw new Error("The helper was disconnected.")
    const id = crypto.randomUUID()
    const payload = { ...fields, id, secret: await sealHelperPassword(password, connection.pair.token, id) }
    pending.set(id, payload)
    try {
        await request("/v1/jobs", payload)
        pending.delete(id)
    } catch (error) {
        if (error instanceof HelperRequestError) {
            pending.delete(id)
            throw error
        }
        renderPanel?.()
        throw new Error(
            "The helper's acknowledgement was interrupted. Check Background transfers or use Retry handoff there before starting another copy.",
            { cause: error },
        )
    }
    showToast("Transfer accepted by the helper. You can close this tab.", "success")
    await refresh()
}
export async function queueBackgroundDownload(client: any, entry: { msgId: number; data: any }, password: string) {
    if (!hasBackgroundHelper(client)) throw new Error("Pair with the background helper first.")
    await submit(
        {
            direction: "download",
            messageId: entry.msgId,
            name: entry.data.name,
            size: entry.data.size,
            ufid: entry.data.ufid,
            fileVersion: entry.data.version ?? 1,
        },
        password,
    )
}
export async function queueBackgroundUpload(client: any, parentFolderId = TGLFS_ROOT_PARENT_ID, dropped = false) {
    if (!hasBackgroundHelper(client)) return
    if (!state?.roots.length)
        throw new Error(
            "No upload folders have been granted. Restart the helper with --upload-root followed by the folder to use.",
        )
    if (dropped)
        showToast("Choose the files again from the helper's folders so the upload can continue after closing this tab.")
    const selection = await pickHelperFiles()
    if (!selection) return
    const password = await requestText({
        title: "Upload in background",
        message:
            selection.files.length === 1
                ? selection.files[0]
                : `${selection.files.length} files will be uploaded as a tar archive.`,
        label: "Encryption password (optional)",
        inputType: "password",
        allowEmpty: true,
        confirmLabel: "Upload",
    })
    if (password === null) return
    await submit({ direction: "upload", ...selection, name: defaultArchiveName(new Date()), parentFolderId }, password)
}
async function pickHelperFiles(): Promise<{ rootId: string; files: string[] } | null> {
    return new Promise((resolve) => {
        const view = modal("Choose files on this computer")
        let rootId = state!.roots[0].id,
            path = "",
            sequence = 0
        const selected = new Set<string>()
        let finished = false
        const finish = (result: { rootId: string; files: string[] } | null) => {
            if (finished) return
            finished = true
            sequence++
            view.close()
            resolve(result)
        }
        view.actions.replaceChildren(button("Cancel", () => finish(null)))
        const upload = button("Upload selected", () => finish({ rootId, files: [...selected] }), true)
        upload.disabled = true
        view.actions.append(upload)
        view.dialog.addEventListener("cancel", () => finish(null))
        const render = async () => {
            const current = ++sequence
            const listing = await request("/v1/browse", { rootId, path })
            if (current !== sequence || finished) return
            view.content.replaceChildren()
            const roots = document.createElement("select")
            roots.className = "fx-input"
            roots.setAttribute("aria-label", "Granted upload folder")
            for (const root of state!.roots) {
                const option = document.createElement("option")
                option.value = root.id
                option.textContent = root.name
                roots.append(option)
            }
            roots.value = rootId
            roots.onchange = () => {
                rootId = roots.value
                path = ""
                selected.clear()
                upload.disabled = true
                void render().catch(reportError)
            }
            view.content.append(roots)
            text(view.content, "p", path || "Folder root")
            if (path)
                view.content.append(
                    button("Up one folder", async () => {
                        path = path.split("/").slice(0, -1).join("/")
                        await render()
                    }),
                )
            const list = document.createElement("div")
            list.className = "fx-helper-files"
            view.content.append(list)
            if (!listing.entries.length) text(list, "p", "This folder is empty.")
            for (const entry of listing.entries) {
                const relative = path ? `${path}/${entry.name}` : entry.name
                if (entry.kind === "directory")
                    list.append(
                        button(`Open ${entry.name}`, async () => {
                            path = relative
                            await render()
                        }),
                    )
                else {
                    const label = document.createElement("label")
                    label.className = "fx-helper-file"
                    const input = document.createElement("input")
                    input.type = "checkbox"
                    input.checked = selected.has(relative)
                    input.onchange = () => {
                        if (input.checked) selected.add(relative)
                        else selected.delete(relative)
                        upload.disabled = selected.size === 0 || selected.size > 1000
                        upload.textContent = `Upload selected (${selected.size})`
                    }
                    label.append(input, document.createTextNode(entry.name))
                    list.append(label)
                }
            }
        }
        void render().catch((error) => {
            reportError(error)
            finish(null)
        })
    })
}
export async function openBackgroundHelper(client: any) {
    if (connection && !hasBackgroundHelper(client)) disconnect()
    const view = modal("Background transfers")
    const render = () => {
        const focused = document.activeElement as HTMLElement | null
        const focusKey = view.content.contains(focused) ? focused?.dataset.helperFocus : undefined
        view.content.replaceChildren()
        if (!connection) {
            text(
                view.content,
                "p",
                "Keep uploads and downloads running after closing the tab with the TGLFS helper on this computer.",
            )
            text(view.content, "p", "Install the current CLI, run tglfs login, then start it with an upload folder:")
            text(view.content, "pre", 'tglfs helper start --upload-root "/path/to/files"')
            text(
                view.content,
                "p",
                "Passwords stay in memory. The helper and computer must remain running. Pair before starting a transfer; browser video conversion still needs an open tab.",
            )
            view.content.append(button("Pair helper", () => pair(client), true))
            return
        }
        text(
            view.content,
            "p",
            `Downloads are saved on this computer in ${state?.downloadDir ?? "the configured folder"}.`,
        )
        text(
            view.content,
            "p",
            "Uploads and downloads started while paired run in the helper. Closing this tab or disconnecting leaves accepted transfers running. After a helper restart, enter the original password to resume.",
        )
        if (connectionError) text(view.content, "p", connectionError).setAttribute("role", "status")
        const disconnectButton = button("Disconnect from this tab", disconnect)
        disconnectButton.dataset.helperFocus = "disconnect"
        view.content.append(disconnectButton)
        for (const [id, payload] of pending)
            view.content.append(
                button(`Retry handoff: ${payload.name ?? "upload"}`, async () => {
                    await request("/v1/jobs", payload)
                    pending.delete(id)
                    await refresh()
                }),
            )
        for (const job of state?.jobs ?? []) {
            const row = document.createElement("section")
            row.className = "fx-helper-job"
            text(row, "strong", job.name)
            text(
                row,
                "p",
                `${job.direction === "upload" ? "Upload" : "Download"} · ${job.phase}${job.total ? ` · ${Math.min(100, Math.floor((job.bytes / job.total) * 100))}%` : ""}`,
            )
            if (job.error) text(row, "p", job.error)
            if (job.result?.outputPath) text(row, "p", job.result.outputPath)
            if (["needs-password", "failed"].includes(job.status)) {
                const action = button("Unlock and resume", () => unlock(job))
                action.dataset.helperFocus = `unlock-${job.id}`
                row.append(action)
            }
            if (!["done", "cancelled"].includes(job.status)) {
                const action = button("Cancel transfer", async () => {
                    await request("/v1/cancel", { id: job.id })
                    await refresh()
                })
                action.dataset.helperFocus = `cancel-${job.id}`
                row.append(action)
            }
            view.content.append(row)
        }
        if (!state?.jobs.length)
            text(view.content, "p", "No background transfers yet. Use Upload files or Download to start one.")
        if (focusKey)
            [...view.content.querySelectorAll<HTMLElement>("[data-helper-focus]")]
                .find((element) => element.dataset.helperFocus === focusKey)
                ?.focus()
    }
    renderPanel = render
    render()
    view.dialog.addEventListener("close", () => {
        if (renderPanel === render) renderPanel = null
    })
    if (connection) await refresh()
}
export function clearBackgroundHelper() {
    disconnect()
}
