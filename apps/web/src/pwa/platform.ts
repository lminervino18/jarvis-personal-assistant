export interface PlatformInfo {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
}

export function isIos({ userAgent, maxTouchPoints }: Pick<PlatformInfo, "userAgent" | "maxTouchPoints">): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** iPhone only allows push and a full-screen app after "Agregar a inicio". */
export function shouldShowInstallHint(info: PlatformInfo, dismissed: boolean): boolean {
  return isIos(info) && !info.standalone && !dismissed;
}

export function readPlatform(): PlatformInfo {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: iosStandalone || window.matchMedia("(display-mode: standalone)").matches,
  };
}
