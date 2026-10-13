// View controller for the "QR code" sign-in panel: renders the code, runs the
// refresh countdown and switches between the loading/ready/expired/scanned/error states.
import { icon } from "./icons"

export type QrPanelState = "loading" | "ready" | "expired" | "scanned" | "error" | "paused"

export type QrLoginPanel = {
    showLoading: (caption?: string) => void
    showCode: (url: string, expiresAt: number) => Promise<void>
    showScanned: () => void
    showError: (caption?: string) => void
    showPaused: () => void
    stop: () => void
    getState: () => QrPanelState
    onRetry: (handler: () => void) => void
}

const QR_LOGO_HREF = "/icons/TGLFS%20logo%20192.png"
const COUNTDOWN_TICK_MS = 250

function requireElement<T extends HTMLElement>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector)
    if (!element) {
        throw new Error(`QR login panel is missing ${selector}`)
    }
    return element
}

export function createQrLoginPanel(root: HTMLElement): QrLoginPanel {
    const codeEl = requireElement<HTMLDivElement>(root, "#loginQrCode")
    const overlayIcon = requireElement<HTMLSpanElement>(root, ".auth-qr-overlay-icon")
    const overlayText = requireElement<HTMLSpanElement>(root, "#loginQrOverlayText")
    const retryButton = requireElement<HTMLButtonElement>(root, "#loginQrRetry")
    const timerFill = requireElement<HTMLSpanElement>(root, "#loginQrTimerFill")
    const caption = requireElement<HTMLSpanElement>(root, "#loginQrCaption")

    let state: QrPanelState = "loading"
    let countdownTimer: number | null = null
    let renderSeq = 0
    let retryHandler: (() => void) | null = null

    retryButton.addEventListener("click", () => retryHandler?.())

    function stopCountdown() {
        if (countdownTimer !== null) {
            window.clearInterval(countdownTimer)
            countdownTimer = null
        }
    }

    function setState(next: QrPanelState, options: { overlay?: string; caption?: string; retryLabel?: string } = {}) {
        state = next
        root.dataset.state = next
        const spinner = next === "loading" || next === "expired"
        // Error/paused states show the retry button instead of the overlay.
        overlayIcon.innerHTML = spinner
            ? '<span class="fx-spinner" aria-hidden="true"></span>'
            : next === "scanned"
              ? icon("check")
              : ""
        overlayText.textContent = options.overlay ?? ""
        if (options.caption !== undefined) {
            caption.textContent = options.caption
        }
        const showRetry = next === "error" || next === "paused"
        retryButton.hidden = !showRetry
        if (showRetry && options.retryLabel) {
            const label = retryButton.lastChild
            if (label && label.nodeType === Node.TEXT_NODE) {
                label.textContent = options.retryLabel
            }
        }
        if (next === "expired") {
            timerFill.style.transform = "scaleX(0)"
        }
    }

    function startCountdown(expiresAt: number) {
        stopCountdown()
        const lifetime = Math.max(1000, expiresAt - Date.now())
        const tick = () => {
            const remaining = expiresAt - Date.now()
            if (remaining <= 0) {
                stopCountdown()
                setState("expired", { overlay: "Refreshing…", caption: "Getting a fresh code…" })
                return
            }
            timerFill.style.transform = `scaleX(${Math.min(1, remaining / lifetime).toFixed(4)})`
            const seconds = Math.ceil(remaining / 1000)
            caption.textContent = `Code refreshes in ${seconds}s`
            root.dataset.urgent = seconds <= 5 ? "true" : "false"
        }
        tick()
        countdownTimer = window.setInterval(tick, COUNTDOWN_TICK_MS)
    }

    return {
        showLoading(text = "Generating a secure code…") {
            stopCountdown()
            renderSeq += 1
            codeEl.innerHTML = ""
            timerFill.style.transform = "scaleX(1)"
            setState("loading", { caption: text })
        },
        async showCode(url, expiresAt) {
            const seq = ++renderSeq
            const { renderQrSvg } = await import("./qrCode")
            if (seq !== renderSeq) {
                return
            }
            codeEl.innerHTML = renderQrSvg(url, { logoHref: QR_LOGO_HREF })
            setState("ready")
            startCountdown(expiresAt)
        },
        showScanned() {
            stopCountdown()
            timerFill.style.transform = "scaleX(1)"
            setState("scanned", { overlay: "Scanned", caption: "Code accepted. Signing you in…" })
        },
        showError(text = "Get a new code to continue.") {
            stopCountdown()
            renderSeq += 1
            // Never leave a dead login code on screen.
            codeEl.innerHTML = ""
            setState("error", { caption: text, retryLabel: "Try again" })
        },
        showPaused() {
            stopCountdown()
            renderSeq += 1
            codeEl.innerHTML = ""
            setState("paused", { caption: "Paused to save battery and data.", retryLabel: "Show a new code" })
        },
        stop() {
            stopCountdown()
            renderSeq += 1
        },
        getState: () => state,
        onRetry(handler) {
            retryHandler = handler
        },
    }
}
