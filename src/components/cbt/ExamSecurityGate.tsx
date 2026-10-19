import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { assertOnlineActionSync } from "@/lib/offline-guard";
import { toast } from "sonner";
import {
  Camera,
  CameraOff,
  Loader2,
  Mic,
  Monitor,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SchoolLogo } from "@/components/brand/SchoolLogo";
import {
  capabilitiesSnapshot,
  detectDeviceCapabilities,
  type DeviceCapabilities,
} from "@/lib/device-capabilities";
import { resolveScreenShareMode } from "@/lib/exam-security";
import type { ExamSecuritySettings } from "@/types";
import { cn } from "@/lib/utils";
import { primeHaptics } from "@/lib/haptic";
import {
  ensureCameraPermission,
  ensureMicrophonePermission,
  openCameraStream,
  requestExamMediaPermissions,
  openAppPermissionSettings,
} from "@/native/cameraService";
import { canAttemptScreenShare, startScreenShareStream, holdExamScreenShare } from "@/lib/screen-share";

type Props = {
  examTitle: string;
  courseLine: string;
  durationMinutes: number;
  totalQuestions: number;
  security: ExamSecuritySettings;
  busy: boolean;
  schoolLogoUrl?: string | null;
  schoolName?: string | null;
  continueMode?: boolean;
  windowLabel?: string | null;
  cancelTo?: string;
  onStart: (opts: {
    skipScreenShare: boolean;
    caps: DeviceCapabilities;
  }) => void | Promise<void>;
};

function CheckRow({
  ok,
  label,
  detail,
}: {
  ok: boolean | "na";
  label: string;
  detail?: string;
}) {
  return (
    <li className="flex items-start justify-between gap-3 text-sm">
      <span className="text-slate-700">{label}</span>
      <span
        className={cn(
          "shrink-0 text-right text-xs font-semibold",
          ok === true && "text-emerald-600",
          ok === false && "text-amber-700",
          ok === "na" && "text-slate-400",
        )}
      >
        {ok === true ? "✓ Ready" : ok === false ? "✗ Not available" : detail || "—"}
      </span>
    </li>
  );
}

export function ExamSecurityGate({
  examTitle,
  courseLine,
  durationMinutes,
  totalQuestions,
  security,
  busy,
  schoolLogoUrl,
  schoolName,
  continueMode = false,
  windowLabel,
  cancelTo = "/student/examinations",
  onStart,
}: Props) {
  const caps = useMemo(() => detectDeviceCapabilities(), []);
  const [acknowledgedNotice, setAcknowledgedNotice] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const [previewState, setPreviewState] = useState<"idle" | "starting" | "live" | "error">("idle");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [permBusy, setPermBusy] = useState(false);
  const [camGranted, setCamGranted] = useState(false);
  const [micGranted, setMicGranted] = useState(false);
  const [screenGranted, setScreenGranted] = useState(false);
  const [permHint, setPermHint] = useState<string | null>(null);

  const shareMode = resolveScreenShareMode(security);
  const needCam = security.requireCamera;
  const needMic = security.requireMicrophone;
  const needFace = needCam && security.faceDetection;

  const stopPreview = () => {
    previewStreamRef.current?.getTracks().forEach((t) => t.stop());
    previewStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const requestAllExamPermissions = async () => {
    setPermBusy(true);
    setPermHint(null);
    try {
      if (needCam || needMic) {
        const { camera, microphone } = await requestExamMediaPermissions({
          camera: needCam,
          microphone: needMic,
        });
        if (needCam) {
          setCamGranted(Boolean(camera.granted));
          if (!camera.granted) {
            setPermHint(camera.error || "Allow Camera for D4EXAM to continue.");
          } else {
            await startPreview();
          }
        }
        if (needMic) {
          setMicGranted(Boolean(microphone.granted));
          if (!microphone.granted) {
            setPermHint((h) => h || microphone.error || "Allow Microphone for D4EXAM if required.");
          }
        }
      }
      if (shareMode !== "disabled" && canAttemptScreenShare()) {
        try {
          const share = await startScreenShareStream();
          if (share.ok) {
            holdExamScreenShare(true);
            setScreenGranted(true);
          } else if (share.reason === "denied") {
            setScreenGranted(false);
            setPermHint(share.message || "Screen share denied.");
          }
        } catch {
          /* optional */
        }
      }
    } finally {
      setPermBusy(false);
    }
  };

  const startPreview = async () => {
    // Must be called from a user gesture (button). Auto-start on mount hangs on many mobile WebViews.
    setPreviewState("starting");
    setPreviewError(null);
    setPermHint(null);
    const safety = window.setTimeout(() => {
      setPreviewState((s) => {
        if (s === "starting") {
          setPreviewError(
            "Camera took too long. Tap Enable camera again, or open App Settings → enable Camera, then retry.",
          );
          return "error";
        }
        return s;
      });
    }, 28_000);
    try {
      stopPreview();
      const stream = await openCameraStream({
        facingMode: "user",
        audio: Boolean(needMic),
      });
      previewStreamRef.current = stream;
      setCamGranted(true);
      if (needMic) setMicGranted(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setPreviewState("live");
    } catch (e) {
      const msg = (e as Error)?.message || "";
      setPreviewState("error");
      setPreviewError(
        msg ||
          (needMic
            ? "Camera/microphone unavailable. Allow Camera and Microphone for D4EXAM (Android Settings → Apps → D4EXAM → Permissions), then try again."
            : "Camera unavailable. Allow camera access for D4EXAM (Android Settings → Apps → D4EXAM → Permissions), close other apps using the camera, then try again."),
      );
      setPermHint(msg || null);
    } finally {
      window.clearTimeout(safety);
    }
  };

  // Cleanup only — never auto-start getUserMedia without a user gesture.
  useEffect(() => {
    return () => stopPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const screenSupported = caps.screenShare;
  const hardBlock = shareMode === "required" && !screenSupported;
  const willRequestScreen =
    screenSupported && (shareMode === "required" || shareMode === "optional");
  const cameraBlocked = needCam && previewState !== "live";
  const micBlocked = needMic && !micGranted;

  const buttonLabel = (() => {
    if (busy) return null;
    if (hardBlock) return "Cannot start on this device";
    if (cameraBlocked) return "Camera preview required — tap Enable camera";
    if (micBlocked) return "Microphone required — tap Enable microphone";
    if (!acknowledgedNotice) return "Accept the monitoring notice to continue";
    if (willRequestScreen && shareMode === "required") return "Share Screen & Continue";
    if (willRequestScreen && shareMode === "optional") return "Continue (screen optional)";
    if (continueMode) return "Continue examination";
    if (needCam) return "Start examination";
    return "Begin examination";
  })();

  const tabLimit = Math.max(1, Number(security.maxTabSwitches) || 5);
  const tabAction = security.thresholdAction || "flag";
  const pauseSecs = Math.max(30, Number(security.pauseDurationSeconds) || 300);
  const tabConsequenceLabel =
    tabAction === "terminate"
      ? "Exam Termination"
      : tabAction === "pause"
        ? `Pause Exam (${Math.round(pauseSecs / 60) || 1} min)`
        : tabAction === "auto_submit"
          ? "Auto-Submit Exam"
          : tabAction === "warn"
            ? "Warning Only"
            : "Flag for Review";
  const tabConsequenceExplain =
    tabAction === "terminate"
      ? `Leaving the examination screen ${tabLimit} times will terminate your examination.`
      : tabAction === "pause"
        ? `Leaving the examination screen ${tabLimit} times will pause your examination for ${Math.round(pauseSecs / 60) || 1} minute(s).`
        : tabAction === "auto_submit"
          ? `Leaving the examination screen ${tabLimit} times will automatically submit your examination.`
          : tabAction === "warn"
            ? "You will receive a warning when the configured violation limit is reached."
            : `Leaving the examination screen ${tabLimit} times will flag your examination for review.`;

  const secRows: { label: string; enabled: boolean; detail?: string }[] = [
    { label: "Camera monitoring", enabled: Boolean(security.requireCamera) },
    {
      label: "Face detection",
      enabled: Boolean(security.faceDetection),
      detail: security.faceDetection ? `max ${security.maxFaceWarnings}` : undefined,
    },
    { label: "Microphone", enabled: Boolean(security.requireMicrophone) },
    { label: "Fullscreen", enabled: Boolean(security.fullscreen) },
    {
      label: "Tab monitoring",
      enabled: Boolean(security.tabMonitoring),
      detail: security.tabMonitoring ? `max ${tabLimit}` : undefined,
    },
    {
      label: "Tab violation consequence",
      enabled: Boolean(security.tabMonitoring),
      detail: security.tabMonitoring ? tabConsequenceLabel : undefined,
    },
    { label: "Copy/paste block", enabled: Boolean(security.blockCopyPaste) },
    {
      label: "Screen sharing",
      enabled: shareMode !== "disabled",
      detail: shareMode === "disabled" ? undefined : shareMode,
    },
    {
      label: "Calculator",
      enabled: Boolean(security.allowCalculator),
      detail: security.allowCalculator
        ? (security.calculatorType === "scientific" ? "Scientific" : "Basic")
        : undefined,
    },
  ];

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-50 p-3 sm:p-6">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div className="flex flex-col items-center text-center">
          <SchoolLogo
            logoUrl={schoolLogoUrl}
            schoolName={schoolName}
            priority
            size="xl"
            className="ring-1 ring-slate-200"
          />
          <p className="mt-3 text-base font-extrabold leading-tight text-slate-900 sm:text-lg">
            {schoolName || "School"}
          </p>
        </div>

        <h1 className="mt-4 text-center text-lg font-extrabold text-primary sm:text-xl">{examTitle}</h1>
        <p className="mt-1 text-center text-sm font-semibold text-primary/80">{courseLine}</p>
        {windowLabel && (
          <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-center text-xs text-slate-600">
            <span className="font-semibold text-slate-800">Available:</span> {windowLabel}
            <span className="mx-1">·</span>
            <span className="font-semibold text-slate-800">Duration:</span> {durationMinutes} min
            <span className="mx-1">·</span>
            <span className="font-semibold text-slate-800">Questions:</span> {totalQuestions}
          </p>
        )}

        <p className="mt-3 text-center text-xs text-slate-500">
          Detected: <strong className="text-slate-700">{caps.deviceType}</strong> ·{" "}
          <strong className="text-slate-700">{caps.browserName}</strong>
          {!caps.secureContext && (
            <span className="text-amber-700"> · insecure context (HTTPS recommended)</span>
          )}
        </p>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
          <p className="text-sm font-extrabold text-slate-900">Exam security configuration</p>
          <p className="mt-0.5 text-[11px] text-slate-500">Loaded from the approved exam record (not defaults)</p>
          <ul className="mt-3 space-y-1.5">
            {secRows.map((r) => (
              <li key={r.label} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-700">{r.label}</span>
                <span className={cn("text-xs font-bold", r.enabled ? "text-emerald-600" : "text-slate-400")}>
                  {r.enabled ? (r.detail ? `Enabled (${r.detail})` : "Enabled") : "Off"}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
          <p className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
            <ShieldCheck className="h-4 w-4 text-primary" />
            DEVICE CHECK
          </p>
          <ul className="mt-3 space-y-2">
            <CheckRow ok={!needCam ? "na" : caps.camera} label="Camera" detail={!needCam ? "Not required" : undefined} />
            <CheckRow
              ok={!needFace ? "na" : caps.faceDetection || caps.camera}
              label="Face detection"
              detail={!needFace ? "Off" : undefined}
            />
            <CheckRow
              ok={shareMode === "disabled" ? "na" : screenSupported ? true : false}
              label={`Screen sharing (${shareMode})`}
              detail={shareMode === "disabled" ? "Disabled" : undefined}
            />
            <CheckRow ok={!needMic ? "na" : caps.microphone} label="Microphone" detail={!needMic ? "Not required" : undefined} />
          </ul>
        </div>

        {(shareMode === "required" || shareMode === "optional") && !screenSupported && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
            <p className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
              <Smartphone className="h-4 w-4 text-primary" />
              Screen Monitoring Unavailable
            </p>
            <p className="mt-2 text-sm text-slate-600">
              Your current device or browser does not support screen sharing.
            </p>
            {shareMode === "required" ? (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                This examination <strong>requires</strong> a desktop or laptop browser with screen-sharing support.
              </p>
            ) : (
              <p className="mt-3 text-xs text-slate-500">You can continue with the other available security features.</p>
            )}
          </div>
        )}

        {screenSupported && shareMode !== "disabled" && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
            <Monitor className="h-3.5 w-3.5" />
            ✓ Screen Sharing Available
          </div>
        )}

        {needCam && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
            <p className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
              <Camera className="h-4 w-4 text-primary" />
              Camera check
            </p>
            <div className="mt-3 overflow-hidden rounded-xl bg-slate-900">
              <video
                ref={videoRef}
                muted
                playsInline
                autoPlay
                className={cn("aspect-video w-full scale-x-[-1] object-cover", previewState !== "live" && "hidden")}
              />
              {previewState !== "live" && (
                <div className="grid aspect-video w-full place-items-center text-center text-xs text-slate-300">
                  {previewState === "starting" ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Starting camera…
                    </span>
                  ) : (
                    <span className="inline-flex flex-col items-center gap-2 px-4">
                      <CameraOff className="h-5 w-5" />
                      {previewError ?? "Camera preview not started — tap Enable camera"}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className={cn("text-xs font-semibold", previewState === "live" ? "text-emerald-600" : "text-amber-700")}>
                {previewState === "live" ? "✓ Camera verified — you are visible" : "Camera not verified yet"}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  stopPreview();
                  void startPreview();
                }}
                disabled={previewState === "starting"}
              >
                {previewState === "live" ? "Restart camera" : "Enable camera"}
              </Button>
            </div>
          </div>
        )}

        {needMic && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
            <p className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
              <Mic className="h-4 w-4 text-primary" />
              Microphone check
            </p>
            <p className="mt-2 text-xs text-slate-600">
              This examination requires your microphone. Allow microphone access so the examination officer can hear live audio during the exam.
            </p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className={"text-xs font-semibold " + (micGranted ? "text-emerald-600" : "text-amber-700")}>
                {micGranted ? "✓ Microphone allowed" : "Microphone not enabled yet"}
              </p>
              <Button type="button" size="sm" variant="outline" disabled={permBusy}
                onClick={() => {
                  void (async () => {
                    setPermBusy(true);
                    try {
                      const r = await ensureMicrophonePermission();
                      setMicGranted(Boolean(r.granted));
                      if (!r.granted) setPermHint(r.error || "Allow Microphone for D4EXAM in App Settings.");
                      else if (needCam) await startPreview();
                    } finally { setPermBusy(false); }
                  })();
                }}>
                {micGranted ? "Recheck mic" : "Enable microphone"}
              </Button>
            </div>
          </div>
        )}

        <ul className="mt-4 space-y-1 text-sm text-slate-600">
          <li>
            Duration: <strong>{durationMinutes} minutes</strong>
          </li>
          <li>
            Questions to answer: <strong>{totalQuestions}</strong>
          </li>
        </ul>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-extrabold text-slate-900">Monitoring notice</p>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed text-slate-600">
            {needCam && (
              <li>
                • Your camera stays on for the whole examination. Face checks run locally —{" "}
                <strong>no video is uploaded or recorded</strong>.
              </li>
            )}
            {needFace && <li>• Warnings are shown if no face or multiple faces are detected.</li>}
            {needMic && <li>• Your microphone is active for the duration of the examination.</li>}
            {shareMode !== "disabled" && <li>• Screen activity may be monitored while you write.</li>}
            {security.tabMonitoring && (
              <>
                <li>• Maximum tab violations: <strong>{tabLimit}</strong></li>
                <li>• Consequence: <strong>{tabConsequenceLabel}</strong></li>
                <li>• {tabConsequenceExplain}</li>
              </>
            )}
            <li>• Security events are stored for review.</li>
          </ul>
          <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs text-slate-700">
            <Checkbox
              checked={acknowledgedNotice}
              onCheckedChange={(v) => setAcknowledgedNotice(v === true)}
              className="mt-0.5"
            />
            <span>I have read and understood the examination instructions and security rules.</span>
          </label>
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          Monitoring helps maintain exam integrity. Device and browser details are logged for authorised review.
        </p>

        {(needCam || needMic || shareMode !== "disabled") && (
          <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3 sm:p-4">
            <p className="text-sm font-extrabold text-primary">Allow required permissions</p>
            <p className="text-xs text-slate-600 mt-1">Tap so the app can request Camera, Microphone, and Screen share.</p>
            <div className="mt-3">
              <Button type="button" className="h-11 w-full rounded-xl font-bold" disabled={permBusy || busy} onClick={() => void requestAllExamPermissions()}>
                {permBusy ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Requesting...</>) : ("Allow camera, mic & screen")}
              </Button>
            </div>
            <ul className="mt-3 space-y-1 text-xs font-semibold">
              {needCam && (<li className={camGranted || previewState === "live" ? "text-emerald-700" : "text-amber-700"}>{(camGranted || previewState === "live") ? "OK" : "--"} Camera</li>)}
              {needMic && (<li className={micGranted ? "text-emerald-700" : "text-amber-700"}>{micGranted ? "OK" : "--"} Microphone</li>)}
              {shareMode !== "disabled" && (<li className={screenGranted ? "text-emerald-700" : "text-slate-600"}>{screenGranted ? "OK" : "--"} Screen share</li>)}
            </ul>
            {permHint && (<p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{permHint}</p>)}
          </div>
        )}

        {totalQuestions === 0 ? (
          <p className="mt-4 text-sm text-amber-700">No questions on this exam paper yet.</p>
        ) : (
          <Button
            className="mt-6 w-full font-semibold"
            disabled={busy || hardBlock || cameraBlocked || micBlocked || !acknowledgedNotice}
            onClick={() => {
              void (async () => {
                primeHaptics();
                stopPreview();
                {
                  // Only block when the browser explicitly reports offline
                  if (typeof navigator !== "undefined" && navigator.onLine === false) {
                    toast.error(assertOnlineActionSync() || "Internet connection required for this action.");
                    return;
                  }
                }
                await onStart({
                  skipScreenShare: !willRequestScreen || (shareMode === "optional" && !screenSupported),
                  caps,
                });
              })();
            }}
          >
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Preparing…
              </>
            ) : (
              buttonLabel
            )}
          </Button>
        )}

        <Button variant="ghost" className="mt-2 w-full" asChild>
          <Link to={cancelTo}>Cancel</Link>
        </Button>

        <span className="sr-only" data-caps={JSON.stringify(capabilitiesSnapshot(caps))} />
      </div>
    </div>
  );
}
