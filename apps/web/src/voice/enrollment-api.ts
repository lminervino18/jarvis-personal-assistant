export interface EnrollmentState {
  phrases: string[];
  recorded: number[];
  enrolled: boolean;
  sampleRate: number;
}

const URL = "/api/voice/enrollment";

export async function fetchEnrollment(): Promise<EnrollmentState | null> {
  try {
    const response = await fetch(URL, { credentials: "same-origin" });
    return response.ok ? ((await response.json()) as EnrollmentState) : null;
  } catch {
    return null;
  }
}

/** Uploads one phrase as raw 16 kHz mono 16-bit PCM; answers the new state, or an error message. */
export async function uploadSample(index: number, samples: Int16Array): Promise<EnrollmentState | string> {
  try {
    const response = await fetch(`${URL}/${index}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([samples.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }),
    });
    if (response.ok) return (await response.json()) as EnrollmentState;
    return response.status === 400 ? "Fue muy corta: leé la frase completa." : "No pude subir la grabación. Probá de nuevo.";
  } catch {
    return "No hay conexión con el servidor.";
  }
}

export async function resetEnrollment(): Promise<EnrollmentState | null> {
  try {
    const response = await fetch(URL, { method: "DELETE", credentials: "same-origin" });
    return response.ok ? ((await response.json()) as EnrollmentState) : null;
  } catch {
    return null;
  }
}
