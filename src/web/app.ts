import "./polyfills"
import { hydrateIcons, icon } from "./icons"
import { isCompactViewport, requestConfirm, showToast } from "./dialogs"
import { begin as beginTransfer, type TransferHandle } from "./transfers"
import { mountTransferTray } from "./transferTray"
import { createQrLoginPanel } from "./qrLoginPanel"
import { mountTransferAttention } from "./transferAttention"
import { clearRecentItems } from "./recentItems"
import { clearStorageSummaryCache } from "./storageStats"

type TelegramModule = typeof import("../telegram")
type BrowserModule = typeof import("./browser")
type DirectoryParentMigrationProgress = import("../telegram").DirectoryParentMigrationProgress
type QrLoginHandlers = import("../telegram").QrLoginHandlers
type TelegramAccount = import("../telegram").TelegramAccount

let telegramModulePromise: Promise<TelegramModule> | null = null
let browserModulePromise: Promise<BrowserModule> | null = null

let activeClient: any = null
let activeConfig: any = null
let pendingShareFiles: File[] | null = null
let shareTargetReceived = false
let shareTargetPollAttempts = 0
let shareTargetPollTimer: number | null = null

const SHARE_TARGET_POLL_INTERVAL_MS = 400
const SHARE_TARGET_MAX_ATTEMPTS = 15

type SharedFileRecord = {
    name?: string
    type?: string
    lastModified?: number
    blob?: Blob
}

let loginAttempt = 0
let loginAbortController: AbortController | null = null
let controlsBound = false
let fileBrowserInitialized = false

type LoginStep = "phone" | "code" | "password" | "qr"
type LoginMethod = "phone" | "qr"

/** Remembers which sign-in method the user picked last (UI preference only). */
const LOGIN_METHOD_STORAGE_KEY = "tglfs.loginMethod"
/** Session cookie used for auto-login when the account's phone number is not visible. */
const ACCOUNT_COOKIE = "tglfsAccount"
/** Stop rotating QR codes after this long without a scan; the user can resume with one click. */
const QR_LOGIN_IDLE_LIMIT_MS = 10 * 60 * 1000

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (reason?: unknown) => void
}

const LOGIN_CANCELLED = "LOGIN_CANCELLED"

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve
        reject = innerReject
    })
    return { promise, resolve, reject }
}

async function getTelegramModule(): Promise<TelegramModule> {
    if (!telegramModulePromise) {
        telegramModulePromise = import("../telegram")
    }
    return telegramModulePromise
}

async function getBrowserModule(): Promise<BrowserModule> {
    if (!browserModulePromise) {
        browserModulePromise = import("./browser")
    }
    return browserModulePromise
}

async function maybeUploadSharedFiles() {
    if (!pendingShareFiles || !activeClient || !activeConfig) {
        return
    }
    const files = pendingShareFiles
    pendingShareFiles = null
    const Telegram = await getTelegramModule()
    await Telegram.fileUpload(activeClient, activeConfig, files)
}

function getLocalMockMode(): string | null {
    const url = new URL(window.location.href)
    const localHost = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    return localHost ? url.searchParams.get("mock") : null
}

function isLocalMockFolderBrowserUrl() {
    return getLocalMockMode() === "folder-browser"
}

/** Dev-only preview of the QR sign-in states with fake tokens (`?mock=qr-login&qr-state=...`). */
function isLocalMockQrLoginUrl() {
    return getLocalMockMode() === "qr-login"
}

async function startMockFolderBrowser() {
    const { createMockFolderBrowserSession } = await import("./mockFolderBrowser")
    const { client, config } = createMockFolderBrowserSession()
    if (new URL(window.location.href).searchParams.get("run") === "webm") {
        const { seedMockWebmFixtures } = await import("./mockWebmFixtures")
        await seedMockWebmFixtures(client, config, new URL(window.location.href).searchParams.get("empty") === "1" ? "" : "webm-test")
    }
    if (new URL(window.location.href).searchParams.get("run") === "archive" && "serviceWorker" in navigator) {
        await navigator.serviceWorker.register("/service-worker.js", { type: "module", updateViaCache: "none" })
        await navigator.serviceWorker.ready
    }
    await finalizeLogin(client, config, { phone: "mock-folder-browser" })
    expireCookie("phone")
}

async function openFileBrowser() {
    if (!activeClient || !activeConfig) {
        return
    }
    const fileBrowserDiv = document.getElementById("fileBrowser")
    fileBrowserDiv?.removeAttribute("hidden")
    document.body.classList.add("file-browser-active")
    const { initFileBrowser } = await getBrowserModule()
    await initFileBrowser(activeClient, activeConfig)
    if (fileBrowserInitialized) {
        window.dispatchEvent(new Event("tglfs:refresh-browser"))
    }
    fileBrowserInitialized = true
}

const THEME_STORAGE_KEY = "tglfs.theme"

function applyTheme(theme: "light" | "dark") {
    if (theme === "dark") {
        document.documentElement.dataset.theme = "dark"
    } else {
        delete document.documentElement.dataset.theme
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0e1116" : "#f7f8fa")
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme)
    const toggle = document.getElementById("themeToggle")
    if (toggle) {
        toggle.innerHTML = `${icon(theme === "dark" ? "sun" : "moon")}${theme === "dark" ? "Light mode" : "Dark mode"}`
        toggle.setAttribute("aria-pressed", String(theme === "dark"))
    }
}

function wireThemeToggle() {
    let saved: string | null = null
    try {
        saved = localStorage.getItem(THEME_STORAGE_KEY)
    } catch {}
    applyTheme(saved === "dark" ? "dark" : "light")
    document.getElementById("themeToggle")?.addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark"
        applyTheme(next)
        try {
            localStorage.setItem(THEME_STORAGE_KEY, next)
        } catch {}
    })
}

function clearShareTargetQuery() {
    if (!window.location.search.includes("share-target")) {
        return
    }
    const url = new URL(window.location.href)
    url.searchParams.delete("share-target")
    window.history.replaceState({}, "", url.toString())
}

function queueShareFiles(files: File[]) {
    if (!files.length) {
        return
    }
    pendingShareFiles = pendingShareFiles ? pendingShareFiles.concat(files) : files
    void maybeUploadSharedFiles()
}

/** Shows a folder-index migration progress report on its transfer-tray task row. */
function reportDirectoryMigrationProgress(task: TransferHandle, progress: DirectoryParentMigrationProgress) {
    const counts = [
        progress.foldersScanned !== undefined ? `${progress.foldersScanned} folders scanned` : "",
        progress.manifestsRead !== undefined ? `${progress.manifestsRead} manifests read` : "",
        progress.filesScanned !== undefined ? `${progress.filesScanned} files scanned` : "",
        progress.foldersUpdated !== undefined ? `${progress.foldersUpdated} folders updated` : "",
        progress.filesUpdated !== undefined ? `${progress.filesUpdated} files updated` : "",
        progress.waitSeconds !== undefined ? `waiting ${progress.waitSeconds}s` : "",
    ].filter(Boolean)
    task.update({
        phase: progress.message,
        bytes: progress.completed ?? 0,
        total: progress.total ?? 0,
        unit: "items",
        detail: counts.join(" · ") || null,
    })
}

function normalizeSharedFiles(payload: unknown): File[] {
    const entries = Array.isArray(payload) ? payload : []
    const files: File[] = []
    for (const entry of entries) {
        if (entry instanceof File) {
            files.push(entry)
            continue
        }
        if (!entry || typeof entry !== "object") {
            continue
        }
        const record = entry as SharedFileRecord
        if (!(record.blob instanceof Blob)) {
            continue
        }
        const name =
            typeof record.name === "string" && record.name.trim().length > 0
                ? record.name
                : "shared-file"
        const type = typeof record.type === "string" ? record.type : record.blob.type || ""
        const lastModified = typeof record.lastModified === "number" ? record.lastModified : Date.now()
        files.push(new File([record.blob], name, { type, lastModified }))
    }
    return files
}

async function requestShareTargetFiles() {
    if (!("serviceWorker" in navigator)) {
        return
    }
    const shareTargetLaunch = window.location.search.includes("share-target=1")
    try {
        const registration = await navigator.serviceWorker.ready
        if (!shareTargetLaunch) {
            registration.active?.postMessage({ type: "REQUEST_SHARE_TARGET" })
            return
        }
        if (shareTargetPollTimer !== null) {
            return
        }
        shareTargetPollAttempts = 0
        const poll = () => {
            if (shareTargetReceived) {
                if (shareTargetPollTimer !== null) {
                    window.clearTimeout(shareTargetPollTimer)
                    shareTargetPollTimer = null
                }
                return
            }
            if (shareTargetPollAttempts >= SHARE_TARGET_MAX_ATTEMPTS) {
                shareTargetPollTimer = null
                return
            }
            shareTargetPollAttempts += 1
            registration.active?.postMessage({ type: "REQUEST_SHARE_TARGET" })
            shareTargetPollTimer = window.setTimeout(poll, SHARE_TARGET_POLL_INTERVAL_MS)
        }
        shareTargetPollTimer = window.setTimeout(poll, 200)
    } catch (error) {
        console.warn("Failed to request share target files:", error)
    }
}

async function acknowledgeShareTarget() {
    if (!("serviceWorker" in navigator)) {
        return
    }
    try {
        const registration = await navigator.serviceWorker.ready
        registration.active?.postMessage({ type: "SHARE_TARGET_RECEIVED" })
    } catch (error) {
        console.warn("Failed to acknowledge share target:", error)
    }
}

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
        const data = event.data
        if (!data || data.type !== "SHARE_TARGET_FILES") {
            return
        }
        const files = normalizeSharedFiles(data.files)
        shareTargetReceived = true
        if (shareTargetPollTimer !== null) {
            window.clearTimeout(shareTargetPollTimer)
            shareTargetPollTimer = null
        }
        queueShareFiles(files)
        clearShareTargetQuery()
        void acknowledgeShareTarget()
    })
}

type AuthErrorInfo = {
    message: string
    step?: LoginStep
    suppress?: boolean
}

function getErrorText(error: unknown): string {
    if (typeof error === "string") {
        return error
    }
    if (error && typeof error === "object") {
        const errorObj = error as { message?: string; errorMessage?: string; error?: string }
        return [errorObj.errorMessage, errorObj.message, errorObj.error].filter(Boolean).join(" ")
    }
    return String(error)
}

function parseAuthError(error: unknown): AuthErrorInfo {
    const raw = getErrorText(error)
    const normalized = raw.toUpperCase()

    if (normalized.includes(LOGIN_CANCELLED) || normalized.includes("AUTH_USER_CANCEL")) {
        return { message: "", step: "phone", suppress: true }
    }
    if (normalized.includes("SESSION_NOT_AUTHORIZED")) {
        return { message: "Your saved session has ended. Sign in again to continue.", step: "phone" }
    }
    if (normalized.includes("AUTH_TOKEN_EXPIRED")) {
        return { message: "That QR code expired before it was confirmed. Scan the new code.", step: "qr" }
    }
    if (normalized.includes("AUTH_TOKEN_ALREADY_ACCEPTED") || normalized.includes("AUTH_TOKEN_INVALID")) {
        return { message: "That QR code can no longer be used. Try again with a new code.", step: "qr" }
    }
    if (normalized.includes("PHONE_NUMBER_INVALID")) {
        return { message: "That phone number does not look right.", step: "phone" }
    }
    if (normalized.includes("PHONE_CODE_INVALID")) {
        return { message: "That code is incorrect. Try again.", step: "code" }
    }
    if (normalized.includes("PHONE_CODE_EXPIRED")) {
        return { message: "That code expired. Request a new one and try again.", step: "code" }
    }
    if (normalized.includes("PASSWORD_HASH_INVALID")) {
        return { message: "Incorrect password. Try again.", step: "password" }
    }
    if (normalized.includes("FLOOD_WAIT")) {
        return { message: "Too many attempts. Please wait a bit and try again.", step: "phone" }
    }
    if (normalized.includes("NETWORK") || normalized.includes("CONNECTION") || normalized.includes("TIMEOUT")) {
        return { message: "Could not reach Telegram. Check your connection and try again.", step: "phone" }
    }

    return { message: "Login failed. Please try again.", step: "phone" }
}

type LoginElements = {
    loginDiv: HTMLDivElement
    loginStatus: HTMLDivElement
    loginStatusText: HTMLSpanElement
    loginError: HTMLDivElement
    loginStepIndicator: HTMLDivElement
    loginPhoneForm: HTMLFormElement
    loginCodeForm: HTMLFormElement
    loginPasswordForm: HTMLFormElement
    phoneInput: HTMLInputElement
    loginButton: HTMLButtonElement
    loginCodeInput: HTMLInputElement
    loginCodeSubmit: HTMLButtonElement
    loginPasteCode: HTMLButtonElement
    loginOpenTelegram: HTMLAnchorElement
    loginChangePhone: HTMLButtonElement
    loginPasswordInput: HTMLInputElement
    loginPasswordSubmit: HTMLButtonElement
    loginResetLogin: HTMLButtonElement
    loginPasswordHint: HTMLSpanElement
    loginMethodSwitch: HTMLDivElement
    loginMethodPhone: HTMLButtonElement
    loginMethodQr: HTMLButtonElement
    loginQrPanel: HTMLDivElement
}

function getLoginElements(): LoginElements {
    const loginPasswordHint = document.getElementById("loginPasswordHint") as HTMLSpanElement | null
    const loginMethodSwitch = document.getElementById("loginMethodSwitch") as HTMLDivElement | null
    const loginMethodPhone = document.getElementById("loginMethodPhone") as HTMLButtonElement | null
    const loginMethodQr = document.getElementById("loginMethodQr") as HTMLButtonElement | null
    const loginQrPanel = document.getElementById("loginQrPanel") as HTMLDivElement | null
    if (!loginPasswordHint || !loginMethodSwitch || !loginMethodPhone || !loginMethodQr || !loginQrPanel) {
        throw new Error("Required login elements are missing.")
    }
    const loginDiv = document.getElementById("login") as HTMLDivElement | null
    const loginStatus = document.getElementById("loginStatus") as HTMLDivElement | null
    const loginStatusText = document.getElementById("loginStatusText") as HTMLSpanElement | null
    const loginError = document.getElementById("loginError") as HTMLDivElement | null
    const loginStepIndicator = document.getElementById("loginStepIndicator") as HTMLDivElement | null
    const loginPhoneForm = document.getElementById("loginPhoneForm") as HTMLFormElement | null
    const loginCodeForm = document.getElementById("loginCodeForm") as HTMLFormElement | null
    const loginPasswordForm = document.getElementById("loginPasswordForm") as HTMLFormElement | null
    const phoneInput = document.getElementById("phone") as HTMLInputElement | null
    const loginButton = document.getElementById("loginButton") as HTMLButtonElement | null
    const loginCodeInput = document.getElementById("loginCode") as HTMLInputElement | null
    const loginCodeSubmit = document.getElementById("loginCodeSubmit") as HTMLButtonElement | null
    const loginPasteCode = document.getElementById("loginPasteCode") as HTMLButtonElement | null
    const loginOpenTelegram = document.getElementById("loginOpenTelegram") as HTMLAnchorElement | null
    const loginChangePhone = document.getElementById("loginChangePhone") as HTMLButtonElement | null
    const loginPasswordInput = document.getElementById("loginPassword") as HTMLInputElement | null
    const loginPasswordSubmit = document.getElementById("loginPasswordSubmit") as HTMLButtonElement | null
    const loginResetLogin = document.getElementById("loginResetLogin") as HTMLButtonElement | null

    if (
        !loginDiv ||
        !loginStatus ||
        !loginStatusText ||
        !loginError ||
        !loginStepIndicator ||
        !loginPhoneForm ||
        !loginCodeForm ||
        !loginPasswordForm ||
        !phoneInput ||
        !loginButton ||
        !loginCodeInput ||
        !loginCodeSubmit ||
        !loginPasteCode ||
        !loginOpenTelegram ||
        !loginChangePhone ||
        !loginPasswordInput ||
        !loginPasswordSubmit ||
        !loginResetLogin
    ) {
        throw new Error("Required login elements are missing.")
    }

    return {
        loginDiv,
        loginStatus,
        loginStatusText,
        loginError,
        loginStepIndicator,
        loginPhoneForm,
        loginCodeForm,
        loginPasswordForm,
        phoneInput,
        loginButton,
        loginCodeInput,
        loginCodeSubmit,
        loginPasteCode,
        loginOpenTelegram,
        loginChangePhone,
        loginPasswordInput,
        loginPasswordSubmit,
        loginResetLogin,
        loginPasswordHint,
        loginMethodSwitch,
        loginMethodPhone,
        loginMethodQr,
        loginQrPanel,
    }
}

type LoginUi = {
    elements: LoginElements
    setVisible: (visible: boolean) => void
    setStatus: (message: string, showSpinner?: boolean) => void
    clearStatus: () => void
    showError: (message: string) => void
    clearError: () => void
    setStep: (step: LoginStep) => void
    getStep: () => LoginStep
    setMethod: (method: LoginMethod) => void
    getMethod: () => LoginMethod
    setPasswordHint: (hint?: string) => void
    setBusy: (busy: boolean) => void
    isBusy: () => boolean
    setPhoneValue: (value: string) => void
    getPhoneValue: () => string
    waitForCode: () => Promise<string>
    waitForPassword: () => Promise<string>
    resolveCode: (code: string) => void
    resolvePassword: (password: string) => void
    cancelPending: (reason: string) => void
}

function createLoginUi(): LoginUi {
    const elements = getLoginElements()
    const state = {
        step: "phone" as LoginStep,
        method: "phone" as LoginMethod,
        busy: false,
        codeDeferred: null as Deferred<string> | null,
        passwordDeferred: null as Deferred<string> | null,
    }

    const stepLabels: Record<LoginMethod, Partial<Record<LoginStep, string>>> = {
        phone: {
            phone: "Step 1 of 3",
            code: "Step 2 of 3",
            password: "Step 3 of 3",
        },
        qr: {
            qr: "Step 1 of 2",
            password: "Step 2 of 2",
        },
    }

    function syncMethodSwitch() {
        const entryStep = state.step === "phone" || state.step === "qr"
        elements.loginMethodSwitch.hidden = !entryStep
        for (const button of [elements.loginMethodPhone, elements.loginMethodQr]) {
            const active = button.dataset.method === state.method
            button.classList.toggle("is-active", active)
            button.setAttribute("aria-selected", String(active))
            button.tabIndex = active ? 0 : -1
            button.disabled = state.busy
        }
        elements.loginDiv.dataset.method = state.method
        elements.loginResetLogin.textContent = state.method === "qr" ? "Start over" : "Use a different number"
    }

    function syncInputState() {
        const phoneActive = state.step === "phone"
        const codeActive = state.step === "code"
        const passwordActive = state.step === "password"
        syncMethodSwitch()

        elements.phoneInput.disabled = state.busy || !phoneActive
        elements.loginButton.disabled = state.busy || !phoneActive

        elements.loginCodeInput.disabled = state.busy || !codeActive
        elements.loginCodeSubmit.disabled = state.busy || !codeActive
        elements.loginPasteCode.disabled = state.busy || !codeActive
        elements.loginChangePhone.disabled = state.busy || !codeActive

        elements.loginPasswordInput.disabled = state.busy || !passwordActive
        elements.loginPasswordSubmit.disabled = state.busy || !passwordActive
        elements.loginResetLogin.disabled = state.busy || !passwordActive

        elements.loginOpenTelegram.setAttribute("aria-disabled", (!codeActive).toString())
        elements.loginOpenTelegram.tabIndex = codeActive ? 0 : -1
    }

    function setStep(step: LoginStep) {
        state.step = step
        if (step === "phone" || step === "code") {
            state.method = "phone"
        } else if (step === "qr") {
            state.method = "qr"
        }
        elements.loginPhoneForm.hidden = step !== "phone"
        elements.loginCodeForm.hidden = step !== "code"
        elements.loginPasswordForm.hidden = step !== "password"
        elements.loginQrPanel.hidden = step !== "qr"
        elements.loginStepIndicator.textContent = stepLabels[state.method][step] ?? ""
        syncInputState()
        clearError()

        if (!state.busy) {
            if (step === "phone") {
                elements.phoneInput.focus()
            } else if (step === "code") {
                elements.loginCodeInput.focus()
            } else if (step === "password") {
                elements.loginPasswordInput.focus()
            }
        }
    }

    function setVisible(visible: boolean) {
        if (visible) {
            elements.loginDiv.removeAttribute("hidden")
        } else {
            elements.loginDiv.setAttribute("hidden", "")
        }
    }

    function setStatus(message: string, showSpinner = true) {
        elements.loginStatusText.textContent = message
        elements.loginStatus.hidden = false
        elements.loginStatus.dataset.spinner = showSpinner ? "on" : "off"
    }

    function clearStatus() {
        elements.loginStatus.hidden = true
        elements.loginStatusText.textContent = ""
        elements.loginStatus.dataset.spinner = "off"
    }

    function showError(message: string) {
        elements.loginError.textContent = message
        elements.loginError.hidden = false
    }

    function clearError() {
        elements.loginError.hidden = true
        elements.loginError.textContent = ""
    }

    function setBusy(busy: boolean) {
        state.busy = busy
        syncInputState()
    }

    function setMethod(method: LoginMethod) {
        state.method = method
        syncInputState()
    }

    function setPasswordHint(hint?: string) {
        const trimmed = hint?.trim() ?? ""
        elements.loginPasswordHint.textContent = trimmed ? ` Hint: ${trimmed}` : ""
        elements.loginPasswordHint.hidden = !trimmed
    }

    function setPhoneValue(value: string) {
        elements.phoneInput.value = value
    }

    function getPhoneValue(): string {
        return elements.phoneInput.value
    }

    function waitForCode(): Promise<string> {
        if (state.codeDeferred) {
            state.codeDeferred.reject(new Error(LOGIN_CANCELLED))
        }
        state.codeDeferred = createDeferred<string>()
        return state.codeDeferred.promise
    }

    function waitForPassword(): Promise<string> {
        if (state.passwordDeferred) {
            state.passwordDeferred.reject(new Error(LOGIN_CANCELLED))
        }
        state.passwordDeferred = createDeferred<string>()
        return state.passwordDeferred.promise
    }

    function resolveCode(code: string) {
        if (state.codeDeferred) {
            state.codeDeferred.resolve(code)
            state.codeDeferred = null
        }
    }

    function resolvePassword(password: string) {
        if (state.passwordDeferred) {
            state.passwordDeferred.resolve(password)
            state.passwordDeferred = null
        }
    }

    function cancelPending(reason: string) {
        if (state.codeDeferred) {
            state.codeDeferred.reject(new Error(reason))
            state.codeDeferred = null
        }
        if (state.passwordDeferred) {
            state.passwordDeferred.reject(new Error(reason))
            state.passwordDeferred = null
        }
    }

    return {
        elements,
        setVisible,
        setStatus,
        clearStatus,
        showError,
        clearError,
        setStep,
        getStep: () => state.step,
        setMethod,
        getMethod: () => state.method,
        setPasswordHint,
        setBusy,
        isBusy: () => state.busy,
        setPhoneValue,
        getPhoneValue,
        waitForCode,
        waitForPassword,
        resolveCode,
        resolvePassword,
        cancelPending,
    }
}

const loginUi = createLoginUi()

function sanitizeCode(rawCode: string): string {
    return rawCode.replace(/\D/g, "").slice(0, 6)
}

function submitForm(form: HTMLFormElement) {
    if (typeof form.requestSubmit === "function") {
        form.requestSubmit()
    } else {
        form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }))
    }
}

const qrPanel = createQrLoginPanel(loginUi.elements.loginQrPanel)

/** Starts a new sign-in attempt, cancelling (and disconnecting) any previous one. */
function beginLoginAttempt() {
    abortLoginAttempt()
    loginAbortController = new AbortController()
    return { attemptId: loginAttempt, signal: loginAbortController.signal }
}

function abortLoginAttempt() {
    loginAttempt += 1
    loginAbortController?.abort()
    loginAbortController = null
    loginUi.cancelPending(LOGIN_CANCELLED)
    qrPanel.stop()
}

function readSavedLoginMethod(): LoginMethod | null {
    try {
        const saved = localStorage.getItem(LOGIN_METHOD_STORAGE_KEY)
        return saved === "qr" || saved === "phone" ? saved : null
    } catch {
        return null
    }
}

function getPreferredLoginMethod(): LoginMethod {
    // You can't scan your own phone's screen, so phones default to the phone-number flow.
    return readSavedLoginMethod() ?? (isCompactViewport() ? "phone" : "qr")
}

/** Shows the first step of the selected sign-in method (and starts a QR attempt for "qr"). */
function showLoginEntry(method: LoginMethod = loginUi.getMethod()) {
    if (method === "qr") {
        void startQrLogin()
    } else {
        loginUi.setStep("phone")
    }
}

function switchLoginMethod(method: LoginMethod) {
    if (loginUi.isBusy() || (loginUi.getMethod() === method && (loginUi.getStep() === "phone" || loginUi.getStep() === "qr"))) {
        return
    }
    try {
        localStorage.setItem(LOGIN_METHOD_STORAGE_KEY, method)
    } catch {}
    abortLoginAttempt()
    loginUi.clearStatus()
    loginUi.clearError()
    showLoginEntry(method)
}

function cancelLoginFlow() {
    abortLoginAttempt()
    loginUi.setBusy(false)
    loginUi.clearStatus()
    loginUi.clearError()
    loginUi.elements.loginCodeInput.value = ""
    loginUi.elements.loginPasswordInput.value = ""
    loginUi.setPasswordHint()
    showLoginEntry()
}

function expireCookie(name: string) {
    document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

function getCookie(name: string): string | null {
    const value = `; ${document.cookie}`
    const parts = value.split(`; ${name}=`)
    if (parts.length === 2) {
        const cookieValue = parts.pop()?.split(";").shift() || null
        return cookieValue ? decodeURIComponent(cookieValue) : null
    }
    return null
}

function createLoginConfig(phone: string) {
    const apiIdFromEnv = 20227969
    const apiHashFromEnv = "3fc5e726fcc1160a81704958b2243109"

    return {
        apiId: Number(apiIdFromEnv),
        apiHash: String(apiHashFromEnv),
        chunkSize: 1024 ** 3 * 2,
        phone,
    }
}

/** How a signed-in session is remembered for auto-login on the next visit. */
type LoginIdentity = {
    /** Phone number; stored in the `phone` cookie exactly like a phone-number login. */
    phone?: string
    /** Telegram user id, used only when the account's phone number is not available. */
    userId?: string
    /** Text shown in the sidebar account card; defaults to the phone number. */
    label?: string
}

function describeAccount(account: TelegramAccount): string {
    if (account.phone) return account.phone
    if (account.username) return `@${account.username}`
    const name = [account.firstName, account.lastName].filter(Boolean).join(" ")
    return name || `Telegram user ${account.id}`
}

function identityFromAccount(account: TelegramAccount): LoginIdentity {
    return account.phone
        ? { phone: account.phone, label: account.phone }
        : { userId: account.id, label: describeAccount(account) }
}

function persistLoginIdentity(identity: LoginIdentity) {
    if (identity.phone) {
        document.cookie = `phone=${encodeURIComponent(identity.phone)}; path=/`
        expireCookie(ACCOUNT_COOKIE)
    } else if (identity.userId) {
        // The stored Telegram session itself is not keyed by phone, so a user id is
        // enough to know there is a session worth resuming without any prompt.
        document.cookie = `${ACCOUNT_COOKIE}=${encodeURIComponent(identity.userId)}; path=/`
        expireCookie("phone")
    }
}

function clearStoredSession() {
    try {
        if (typeof localStorage === "undefined") {
            return
        }
        const sessionPrefix = "./tglfs.session:"
        for (let i = localStorage.length - 1; i >= 0; i -= 1) {
            const key = localStorage.key(i)
            if (key && key.startsWith(sessionPrefix)) {
                localStorage.removeItem(key)
            }
        }
    } catch (error) {
        console.warn("Failed to clear stored session", error)
    }
    // Account-specific conveniences: palette "Recent" items and the cached storage summary.
    clearRecentItems()
    clearStorageSummaryCache()
}

async function logout() {
    if (browserModulePromise) {
        // Signing out is an explicit "I'm done": write a delete still inside its undo window and let
        // in-flight writes finish while the session is still valid.
        try {
            await (await browserModulePromise).settleBrowserMutations()
        } catch (error) {
            console.warn("Failed to finish pending file browser changes", error)
        }
    }
    try {
        await activeClient?.logOut?.()
    } catch (error) {
        console.warn("Failed to log out from Telegram", error)
    }

    try {
        await activeClient?.disconnect?.()
    } catch (error) {
        console.warn("Failed to disconnect Telegram client", error)
    }

    activeClient = null
    activeConfig = null
    pendingShareFiles = null

    expireCookie("phone")
    expireCookie(ACCOUNT_COOKIE)
    clearStoredSession()

    const fileBrowserDiv = document.getElementById("fileBrowser")
    if (fileBrowserDiv) {
        fileBrowserDiv.setAttribute("hidden", "")
    }
    document.body.classList.remove("file-browser-active", "fx-selecting")

    loginUi.setMethod(getPreferredLoginMethod())
    cancelLoginFlow()
    loginUi.setVisible(true)
    loginUi.setPhoneValue("")
    loginUi.setStatus("You have been logged out.", false)
}


async function finalizeLogin(client: any, config: any, identity: LoginIdentity) {
    activeClient = client
    activeConfig = config
    loginAbortController = null
    qrPanel.stop()

    persistLoginIdentity(identity)

    ;(window as any).client = client
    ;(window as any).config = config

    const loginDiv = document.getElementById("login")
    if (loginDiv) {
        loginDiv.setAttribute("hidden", "")
    }
    const accountPhone = document.getElementById("accountPhone")
    if (accountPhone) {
        accountPhone.textContent = identity.label ?? identity.phone ?? ""
    }

    const splashDivAtInit = document.getElementById("splash")
    if (splashDivAtInit) {
        splashDivAtInit.remove()
    }

    if (!controlsBound) {
        const uploadFileInput = document.getElementById("uploadFileInput") as HTMLInputElement | null
        uploadFileInput?.addEventListener("change", async () => {
            if (!activeClient || !activeConfig) {
                return
            }
            const Telegram = await getTelegramModule()
            try {
                await Telegram.fileUpload(activeClient, activeConfig)
            } finally {
                // Allow selecting the same file again.
                uploadFileInput.value = ""
            }
        })
        const downloadFileLegacyButton = document.getElementById("downloadFileLegacyButton") as HTMLButtonElement | null
        downloadFileLegacyButton?.addEventListener("click", async () => {
            if (!activeClient || !activeConfig) {
                return
            }
            const Telegram = await getTelegramModule()
            await Telegram.fileDownloadLegacy(activeClient, activeConfig)
        })

        const migrateDirectoryParentsButton = document.getElementById("migrateDirectoryParentsButton") as HTMLButtonElement | null
        migrateDirectoryParentsButton?.addEventListener("click", async () => {
            if (!activeClient) {
                return
            }
            const ok = await requestConfirm({
                title: "Migrate folder index?",
                message: "This edits TGLFS folder and file-card messages in your Telegram Saved Messages so directory browsing can use parent references. It edits about one record per minute to stay under Telegram rate limits and may pause if Telegram asks it to wait. You can keep browsing while it runs.",
                confirmLabel: "Start migration",
                icon: "wrench",
            })
            if (!ok) return

            const label = migrateDirectoryParentsButton.querySelector("span") ?? migrateDirectoryParentsButton.lastChild
            const originalText = label?.textContent ?? "Migrate folder index"
            migrateDirectoryParentsButton.disabled = true
            if (label) label.textContent = "Migrating…"
            const task = beginTransfer({
                direction: "task",
                name: "Folder index migration",
                queue: false,
                cancellable: false,
                phase: "Starting folder index migration…",
            })
            try {
                const Telegram = await getTelegramModule()
                const result = await Telegram.migrateDirectoryParentRefs(activeClient, {
                    onProgress: (progress) => reportDirectoryMigrationProgress(task, progress),
                })
                const conflicts = result.folderParentConflicts.length + result.fileParentConflicts.length
                const summary = [
                    `${result.foldersUpdated} folders and ${result.filesUpdated} files updated`,
                    conflicts ? `${conflicts} conflicts skipped` : "",
                ].filter(Boolean).join(" · ")
                task.update({
                    detail: `${result.foldersScanned} folders and ${result.filesScanned} files scanned`,
                })
                task.complete({ message: summary, tone: conflicts ? "warning" : "success" })
                showToast(`Folder index migrated: ${summary}`, { tone: "success", durationMs: 8000 })
                window.dispatchEvent(new Event("tglfs:refresh-browser"))
            } catch (error) {
                console.error(error)
                task.fail(error)
                const message = error instanceof Error ? error.message : String(error)
                showToast(`Folder index migration failed: ${message}`, { tone: "error", durationMs: 8000 })
            } finally {
                migrateDirectoryParentsButton.disabled = false
                if (label) label.textContent = originalText
            }
        })

        const logoutButton = document.getElementById("logoutButton") as HTMLButtonElement | null
        logoutButton?.addEventListener("click", async () => {
            await logout()
        })
        controlsBound = true
    }

    await openFileBrowser()
    await maybeUploadSharedFiles()
}

/** Moves to the 2FA step (shared by the phone and QR flows) and waits for the password. */
async function promptForPassword(attemptId: number, hint?: string): Promise<string> {
    if (attemptId !== loginAttempt) {
        throw new Error(LOGIN_CANCELLED)
    }
    // GramJS re-asks after a wrong password; stay on the step so its error stays visible.
    if (loginUi.getStep() !== "password") {
        loginUi.setStep("password")
    }
    loginUi.setPasswordHint(hint)
    loginUi.elements.loginPasswordInput.value = ""
    loginUi.setStatus("Enter your Telegram password to continue.", false)
    loginUi.setBusy(false)
    loginUi.elements.loginPasswordInput.focus()
    return await loginUi.waitForPassword()
}

function showLoginError(error: unknown, fallbackStep: LoginStep) {
    const info = parseAuthError(error)
    loginUi.clearStatus()
    const step = info.step === "phone" || info.step === "qr" ? fallbackStep : info.step
    if (step && loginUi.getStep() !== step) {
        loginUi.setStep(step)
    }
    if (!info.suppress) {
        loginUi.showError(info.message)
    }
    loginUi.setBusy(false)
    return info
}

async function startLogin(phoneNumber: string, options: { auto?: boolean } = {}) {
    const phoneValue = phoneNumber.trim()
    if (phoneValue === "") {
        loginUi.showError("Enter a phone number to continue.")
        return
    }

    const { attemptId, signal } = beginLoginAttempt()

    loginUi.setVisible(true)
    loginUi.setStep("phone")
    loginUi.setPhoneValue(phoneValue)
    loginUi.clearError()
    loginUi.setBusy(true)
    loginUi.setStatus(
        options.auto
            ? "Signing you in with your saved number..."
            : "Sending login code... this can take 10-20 seconds.",
        true,
    )

    const config = createLoginConfig(phoneValue)

    try {
        const Telegram = await getTelegramModule()
        const client = await Telegram.init(config, {
            signal,
            getPhoneCode: async () => {
                if (attemptId !== loginAttempt) {
                    throw new Error(LOGIN_CANCELLED)
                }
                if (loginUi.getStep() !== "code") {
                    loginUi.setStep("code")
                }
                loginUi.elements.loginCodeInput.value = ""
                loginUi.setStatus("Check Telegram for your login code.", false)
                loginUi.setBusy(false)
                loginUi.elements.loginCodeInput.focus()
                return await loginUi.waitForCode()
            },
            getPassword: (hint) => promptForPassword(attemptId, hint),
            onError: (error: unknown) => {
                if (attemptId !== loginAttempt) {
                    return
                }
                const info = parseAuthError(error)
                loginUi.clearStatus()
                if (info.step && loginUi.getStep() !== info.step) {
                    loginUi.setStep(info.step)
                }
                if (!info.suppress) {
                    loginUi.showError(info.message)
                }
                loginUi.setBusy(false)
            },
        })

        if (attemptId !== loginAttempt) {
            return
        }

        loginUi.setStatus("Signed in. Preparing your workspace...", true)
        loginUi.setBusy(true)
        await finalizeLogin(client, config, { phone: phoneValue })
    } catch (error) {
        if (attemptId !== loginAttempt) {
            return
        }
        showLoginError(error, "phone")
    }
}

type QrLoginDriver = (config: ReturnType<typeof createLoginConfig>, handlers: QrLoginHandlers) => Promise<any>

async function getQrLoginDriver(): Promise<QrLoginDriver> {
    if (isLocalMockQrLoginUrl()) {
        const { createMockQrLoginDriver } = await import("./mockQrLogin")
        return createMockQrLoginDriver(new URL(window.location.href).searchParams.get("qr-state"))
    }
    const Telegram = await getTelegramModule()
    return Telegram.initWithQrCode
}

/**
 * QR-code sign-in: shows rotating login tokens for another Telegram app to scan,
 * then continues with the shared 2FA step and persists the session like a phone login.
 */
async function startQrLogin() {
    const { attemptId, signal } = beginLoginAttempt()
    const isStale = () => attemptId !== loginAttempt

    loginUi.setVisible(true)
    loginUi.setBusy(false)
    loginUi.setStep("qr")
    loginUi.clearError()
    loginUi.setPasswordHint()
    qrPanel.showLoading()

    const idleTimer = window.setTimeout(() => {
        if (isStale() || loginUi.getStep() !== "qr") return
        const state = qrPanel.getState()
        if (state === "ready" || state === "expired" || state === "loading") {
            abortLoginAttempt()
            loginUi.clearStatus()
            qrPanel.showPaused()
        }
    }, QR_LOGIN_IDLE_LIMIT_MS)

    const config = createLoginConfig("")
    try {
        const [driver, { buildTelegramLoginUrl }] = await Promise.all([getQrLoginDriver(), import("./qrCode")])
        if (isStale()) {
            return
        }
        const client = await driver(config, {
            signal,
            onQrCode: ({ token, expiresAt }) => {
                if (isStale() || loginUi.getStep() !== "qr") {
                    return
                }
                void qrPanel.showCode(buildTelegramLoginUrl(token), expiresAt)
            },
            onScanned: () => {
                if (isStale()) {
                    return
                }
                window.clearTimeout(idleTimer)
                qrPanel.showScanned()
                loginUi.clearError()
                loginUi.setBusy(true)
            },
            getPassword: (hint) => promptForPassword(attemptId, hint),
            onError: (error: unknown) => {
                if (isStale()) {
                    return
                }
                // GramJS only reports recoverable errors here (e.g. a wrong 2FA password) and retries.
                showLoginError(error, loginUi.getStep() === "password" ? "password" : "qr")
            },
        })

        if (isStale()) {
            void client?.disconnect?.().catch?.(() => undefined)
            return
        }

        window.clearTimeout(idleTimer)
        loginUi.setStatus("Signed in. Preparing your workspace...", true)
        loginUi.setBusy(true)
        const Telegram = await getTelegramModule()
        const account = await Telegram.getSignedInAccount(client)
        if (isStale()) {
            return
        }
        config.phone = account.phone ?? ""
        await finalizeLogin(client, config, identityFromAccount(account))
    } catch (error) {
        window.clearTimeout(idleTimer)
        if (isStale()) {
            return
        }
        // Any failure that ends the attempt returns to the QR panel with a retry button.
        const info = parseAuthError(error)
        loginUi.clearStatus()
        loginUi.setBusy(false)
        loginUi.elements.loginPasswordInput.value = ""
        if (loginUi.getStep() !== "qr") {
            loginUi.setStep("qr")
        }
        if (!info.suppress) {
            loginUi.showError(info.message)
        }
        qrPanel.showError()
    }
}

/**
 * Auto-login for sessions remembered by user id (QR logins on accounts whose phone
 * number is not visible). Never starts an interactive sign-in on its own.
 */
async function resumeSavedSession() {
    const { attemptId, signal } = beginLoginAttempt()
    loginUi.setVisible(true)
    loginUi.setStep(loginUi.getMethod() === "qr" ? "qr" : "phone")
    if (loginUi.getStep() === "qr") {
        qrPanel.showLoading("Restoring your session…")
    }
    loginUi.clearError()
    loginUi.setBusy(true)
    loginUi.setStatus("Signing you in with your saved session...", true)

    const config = createLoginConfig("")
    try {
        const Telegram = await getTelegramModule()
        const client = await Telegram.resumeStoredSession(config, signal)
        const account = await Telegram.getSignedInAccount(client)
        if (attemptId !== loginAttempt) {
            void client.disconnect().catch(() => undefined)
            return
        }
        config.phone = account.phone ?? ""
        loginUi.setStatus("Signed in. Preparing your workspace...", true)
        await finalizeLogin(client, config, identityFromAccount(account))
    } catch (error) {
        if (attemptId !== loginAttempt) {
            return
        }
        const info = parseAuthError(error)
        if (getErrorText(error).includes("SESSION_NOT_AUTHORIZED")) {
            expireCookie(ACCOUNT_COOKIE)
        }
        loginUi.clearStatus()
        loginUi.setBusy(false)
        showLoginEntry()
        if (!info.suppress) {
            loginUi.showError(info.message)
        }
    }
}

function wireLoginHandlers() {
    const { elements } = loginUi
    let codeSubmitTimer: number | null = null

    elements.loginPhoneForm.addEventListener("submit", (event) => {
        event.preventDefault()
        startLogin(elements.phoneInput.value)
    })

    elements.loginCodeForm.addEventListener("submit", (event) => {
        event.preventDefault()
        if (loginUi.isBusy()) {
            return
        }
        const sanitized = sanitizeCode(elements.loginCodeInput.value)
        elements.loginCodeInput.value = sanitized
        if (sanitized.length < 5) {
            loginUi.showError("Enter the full login code.")
            return
        }
        if (codeSubmitTimer) {
            window.clearTimeout(codeSubmitTimer)
            codeSubmitTimer = null
        }
        loginUi.clearError()
        loginUi.setStatus("Verifying code...", true)
        loginUi.setBusy(true)
        loginUi.resolveCode(sanitized)
    })

    elements.loginCodeInput.addEventListener("input", () => {
        const sanitized = sanitizeCode(elements.loginCodeInput.value)
        if (elements.loginCodeInput.value !== sanitized) {
            elements.loginCodeInput.value = sanitized
        }
        if (sanitized.length >= 5 && !loginUi.isBusy()) {
            if (codeSubmitTimer) {
                window.clearTimeout(codeSubmitTimer)
            }
            codeSubmitTimer = window.setTimeout(() => {
                if (!loginUi.isBusy() && loginUi.getStep() === "code") {
                    submitForm(elements.loginCodeForm)
                }
                codeSubmitTimer = null
            }, 250)
        }
    })

    elements.loginPasteCode.addEventListener("click", async () => {
        if (loginUi.isBusy()) {
            return
        }
        try {
            const text = await navigator.clipboard.readText()
            const sanitized = sanitizeCode(text)
            if (!sanitized) {
                loginUi.showError("Clipboard does not contain a login code.")
                return
            }
            elements.loginCodeInput.value = sanitized
            if (codeSubmitTimer) {
                window.clearTimeout(codeSubmitTimer)
                codeSubmitTimer = null
            }
            if (sanitized.length >= 5) {
                submitForm(elements.loginCodeForm)
            }
        } catch (error) {
            console.error("Failed to read clipboard", error)
            loginUi.showError("Unable to read clipboard. Paste the code manually.")
        }
    })

    for (const button of [elements.loginMethodPhone, elements.loginMethodQr]) {
        button.addEventListener("click", () => {
            switchLoginMethod(button.dataset.method === "qr" ? "qr" : "phone")
        })
    }

    elements.loginMethodSwitch.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
            return
        }
        event.preventDefault()
        const next = loginUi.getMethod() === "qr" ? "phone" : "qr"
        switchLoginMethod(next)
        ;(next === "qr" ? elements.loginMethodQr : elements.loginMethodPhone).focus()
    })

    qrPanel.onRetry(() => {
        loginUi.clearStatus()
        void startQrLogin()
    })

    elements.loginChangePhone.addEventListener("click", () => {
        cancelLoginFlow()
    })

    elements.loginResetLogin.addEventListener("click", () => {
        cancelLoginFlow()
    })

    elements.loginOpenTelegram.addEventListener("click", (event) => {
        if (loginUi.getStep() !== "code") {
            event.preventDefault()
        }
    })

    elements.loginPasswordForm.addEventListener("submit", (event) => {
        event.preventDefault()
        if (loginUi.isBusy()) {
            return
        }
        const password = elements.loginPasswordInput.value.trim()
        if (!password) {
            loginUi.showError("Enter your Telegram password.")
            return
        }
        loginUi.clearError()
        loginUi.setStatus("Verifying password...", true)
        loginUi.setBusy(true)
        loginUi.resolvePassword(password)
    })

    elements.phoneInput.addEventListener("input", () => loginUi.clearError())
    elements.loginCodeInput.addEventListener("input", () => loginUi.clearError())
    elements.loginPasswordInput.addEventListener("input", () => loginUi.clearError())
}

hydrateIcons()
wireThemeToggle()
mountTransferTray()
mountTransferAttention()
wireLoginHandlers()

window.addEventListener("load", async () => {
    if (isLocalMockFolderBrowserUrl()) {
        const splashDiv = document.getElementById("splash")
        if (splashDiv) {
            splashDiv.remove()
        }
        await startMockFolderBrowser()
        return
    }

    loginUi.setMethod(getPreferredLoginMethod())

    if (isLocalMockQrLoginUrl()) {
        document.getElementById("splash")?.remove()
        loginUi.setVisible(true)
        const method = new URL(window.location.href).searchParams.get("method")
        showLoginEntry(method === "phone" ? "phone" : "qr")
        return
    }

    if ("serviceWorker" in navigator) {
        try {
            const registration = await navigator.serviceWorker.register(
                "/service-worker.js",
                { type: "module", updateViaCache: "none" },
            )
            if (registration.waiting) {
                registration.waiting.postMessage({ type: "SKIP_WAITING" })
            }
            registration.addEventListener("updatefound", () => {
                const installing = registration.installing
                if (!installing) {
                    return
                }
                installing.addEventListener("statechange", () => {
                    if (installing.state === "installed" && registration.waiting) {
                        registration.waiting.postMessage({ type: "SKIP_WAITING" })
                    }
                })
            })
            navigator.serviceWorker.addEventListener("controllerchange", () => {
                if (!shareTargetReceived) {
                    void requestShareTargetFiles()
                }
            })
        } catch (error) {
            alert(
                "Failed to register ServiceWorker.\nYou will not be able to download files.\nSee developer console for details.",
            )
            console.error("ServiceWorker registration failed: ", error)
        }
        await requestShareTargetFiles()
    }

    const phone = getCookie("phone")
    const savedAccountId = getCookie(ACCOUNT_COOKIE)

    loginUi.setVisible(true)

    if (phone) {
        loginUi.setPhoneValue(phone)
        void startLogin(phone, { auto: true })
    } else if (savedAccountId) {
        void resumeSavedSession()
    } else {
        showLoginEntry()
    }

    const splashDiv = document.getElementById("splash")
    if (splashDiv) {
        splashDiv.remove()
    }
})
