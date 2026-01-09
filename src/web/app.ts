type TelegramModule = typeof import("../telegram")
type BrowserModule = typeof import("./browser")

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
let controlsBound = false

type LoginStep = "phone" | "code" | "password"

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

    if (normalized.includes(LOGIN_CANCELLED)) {
        return { message: "", step: "phone", suppress: true }
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
}

function getLoginElements(): LoginElements {
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
        busy: false,
        codeDeferred: null as Deferred<string> | null,
        passwordDeferred: null as Deferred<string> | null,
    }

    const stepLabels: Record<LoginStep, string> = {
        phone: "Step 1 of 3",
        code: "Step 2 of 3",
        password: "Step 3 of 3",
    }

    function syncInputState() {
        const phoneActive = state.step === "phone"
        const codeActive = state.step === "code"
        const passwordActive = state.step === "password"

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
        elements.loginPhoneForm.hidden = step !== "phone"
        elements.loginCodeForm.hidden = step !== "code"
        elements.loginPasswordForm.hidden = step !== "password"
        elements.loginStepIndicator.textContent = stepLabels[step]
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

function cancelLoginFlow() {
    loginAttempt += 1
    loginUi.cancelPending(LOGIN_CANCELLED)
    loginUi.setBusy(false)
    loginUi.clearStatus()
    loginUi.clearError()
    loginUi.elements.loginCodeInput.value = ""
    loginUi.elements.loginPasswordInput.value = ""
    loginUi.setStep("phone")
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
}

async function logout() {
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

    document.cookie = "phone=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"
    clearStoredSession()

    const controlsDiv = document.getElementById("controls")
    if (controlsDiv) {
        controlsDiv.setAttribute("hidden", "")
    }
    const fileBrowserDiv = document.getElementById("fileBrowser")
    if (fileBrowserDiv) {
        fileBrowserDiv.setAttribute("hidden", "")
    }
    document.body.classList.remove("file-browser-active")

    cancelLoginFlow()
    loginUi.setVisible(true)
    loginUi.setPhoneValue("")
    loginUi.setStatus("You have been logged out.", false)
}


async function finalizeLogin(client: any, config: any, phoneValue: string) {
    activeClient = client
    activeConfig = config

    document.cookie = `phone=${encodeURIComponent(phoneValue)}; path=/`

    ;(window as any).client = client
    ;(window as any).config = config

    const loginDiv = document.getElementById("login")
    if (loginDiv) {
        loginDiv.setAttribute("hidden", "")
    }
    const controlsDiv = document.getElementById("controls")
    if (controlsDiv) {
        controlsDiv.removeAttribute("hidden")
    }
    const fileBrowserDiv = document.getElementById("fileBrowser")

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
            await Telegram.fileUpload(activeClient, activeConfig)
        })
        const downloadFileLegacyButton = document.getElementById("downloadFileLegacyButton") as HTMLButtonElement | null
        downloadFileLegacyButton?.addEventListener("click", async () => {
            if (!activeClient || !activeConfig) {
                return
            }
            const Telegram = await getTelegramModule()
            await Telegram.fileDownloadLegacy(activeClient, activeConfig)
        })

        const fileBrowserButton = document.getElementById("fileBrowserButton") as HTMLButtonElement | null
        fileBrowserButton?.addEventListener("click", async () => {
            if (!activeClient || !activeConfig) {
                return
            }
            controlsDiv?.setAttribute("hidden", "")
            fileBrowserDiv?.removeAttribute("hidden")
            document.body.classList.add("file-browser-active")
            const { initFileBrowser } = await getBrowserModule()
            await initFileBrowser(activeClient, activeConfig)
            window.dispatchEvent(new Event("tglfs:refresh-browser"))
        })

        const logoutButton = document.getElementById("logoutButton") as HTMLButtonElement | null
        logoutButton?.addEventListener("click", async () => {
            await logout()
        })
        controlsBound = true
    }

    await maybeUploadSharedFiles()
}

async function startLogin(phoneNumber: string, options: { auto?: boolean } = {}) {
    const phoneValue = phoneNumber.trim()
    if (phoneValue === "") {
        loginUi.showError("Enter a phone number to continue.")
        return
    }

    const attemptId = ++loginAttempt

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

    const apiIdFromEnv = 20227969
    const apiHashFromEnv = "3fc5e726fcc1160a81704958b2243109"

    const config = {
        apiId: Number(apiIdFromEnv),
        apiHash: String(apiHashFromEnv),
        chunkSize: 1024 ** 3 * 2,
        phone: phoneValue,
    }

    try {
        const Telegram = await getTelegramModule()
        const client = await Telegram.init(config, {
            getPhoneCode: async () => {
                if (attemptId !== loginAttempt) {
                    throw new Error(LOGIN_CANCELLED)
                }
                loginUi.setStep("code")
                loginUi.elements.loginCodeInput.value = ""
                loginUi.setStatus("Check Telegram for your login code.", false)
                loginUi.setBusy(false)
                return await loginUi.waitForCode()
            },
            getPassword: async () => {
                if (attemptId !== loginAttempt) {
                    throw new Error(LOGIN_CANCELLED)
                }
                loginUi.setStep("password")
                loginUi.elements.loginPasswordInput.value = ""
                loginUi.setStatus("Enter your Telegram password to continue.", false)
                loginUi.setBusy(false)
                return await loginUi.waitForPassword()
            },
            onError: (error: unknown) => {
                if (attemptId !== loginAttempt) {
                    return
                }
                const info = parseAuthError(error)
                loginUi.clearStatus()
                if (info.step) {
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
        await finalizeLogin(client, config, phoneValue)
    } catch (error) {
        if (attemptId !== loginAttempt) {
            return
        }
        const info = parseAuthError(error)
        loginUi.clearStatus()
        if (info.step) {
            loginUi.setStep(info.step)
        }
        if (!info.suppress) {
            loginUi.showError(info.message)
        }
        loginUi.setBusy(false)
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

wireLoginHandlers()

window.addEventListener("load", async () => {
    if ("serviceWorker" in navigator) {
        try {
            const registration = await navigator.serviceWorker.register(
                new URL("../service-worker.js", import.meta.url),
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

    function getCookie(name: string): string | null {
        const value = `; ${document.cookie}`
        const parts = value.split(`; ${name}=`)
        if (parts.length === 2) {
            const cookieValue = parts.pop()?.split(";").shift() || null
            return cookieValue ? decodeURIComponent(cookieValue) : null
        }
        return null
    }

    const phone = getCookie("phone")

    loginUi.setVisible(true)

    if (phone) {
        loginUi.setPhoneValue(phone)
        void startLogin(phone, { auto: true })
    } else {
        loginUi.setStep("phone")
    }

    const splashDiv = document.getElementById("splash")
    if (splashDiv) {
        splashDiv.remove()
    }
})
