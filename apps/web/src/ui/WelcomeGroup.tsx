import { useEffect, useState } from "react";
import { fetchTransfers, type TransferFile } from "../transfers/api.js";
import { chooseWelcomeMusic, fetchWelcome, playWelcome, removeWelcomeMusic, updateWelcome, type WelcomeState } from "../welcome.js";

/** The welcome JARVIS says when the app opens: on or off, the phrase, and a song from Transferencias under it. */
export function WelcomeGroup() {
  const [state, setState] = useState<WelcomeState | null>(null);
  const [phrase, setPhrase] = useState("");
  const [start, setStart] = useState("0");
  const [songs, setSongs] = useState<TransferFile[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const apply = (next: WelcomeState | null) => {
    if (!next) return setMessage("No pude guardarlo. Probá de nuevo.");
    setState(next);
    setPhrase(next.phrase);
    setStart(String(next.musicStart));
    setMessage(null);
  };

  useEffect(() => void fetchWelcome().then((next) => next && apply(next)), []);
  if (!state?.available) return null;

  const pickSong = async () => {
    const transfers = await fetchTransfers();
    setSongs((transfers?.items ?? []).filter((item) => item.preview === "audio" || item.preview === "video"));
  };

  const test = async () => {
    setMessage("Preparando…");
    setMessage((await playWelcome({ force: true })) ? null : "Tocá de nuevo para escucharlo.");
  };

  return (
    <div className="group">
      <label className="row">
        <span>Saludo al abrir</span>
        <input type="checkbox" role="switch" className="switch" checked={state.enabled} onChange={(event) => void updateWelcome({ enabled: event.target.checked }).then(apply)} />
      </label>
      <label className="row">
        <span>Frase</span>
        <input
          className="row-input"
          value={phrase}
          maxLength={160}
          onChange={(event) => setPhrase(event.target.value)}
          onBlur={() => phrase.trim().length >= 2 && phrase !== state.phrase && void updateWelcome({ phrase: phrase.trim() }).then(apply)}
        />
      </label>
      <div className="row">
        <span>Música</span>
        <button type="button" className="row-link welcome-song" onClick={() => void pickSong()}>
          {state.musicName ?? "Elegir de Transferencias"}
        </button>
      </div>
      {songs && (
        <ul className="welcome-songs" aria-label="Audios y videos de Transferencias">
          {songs.length === 0 && <li className="group-footer">No hay audios ni videos en Transferencias. Subí la canción ahí y volvé.</li>}
          {songs.map((song) => (
            <li key={song.id}>
              <button
                type="button"
                className="row row-action"
                onClick={() =>
                  void chooseWelcomeMusic(song.id).then((next) => {
                    apply(next);
                    setSongs(null);
                  })
                }
              >
                {song.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.musicName && (
        <>
          <label className="row">
            <span>Empieza en el segundo</span>
            <input
              className="row-input row-input-short"
              type="number"
              inputMode="numeric"
              min={0}
              value={start}
              onChange={(event) => setStart(event.target.value)}
              onBlur={() => Number(start) !== state.musicStart && Number(start) >= 0 && void updateWelcome({ musicStart: Number(start) }).then(apply)}
            />
          </label>
          <button type="button" className="row row-action row-danger" onClick={() => void removeWelcomeMusic().then(apply)}>
            Sacar la música
          </button>
        </>
      )}
      <button type="button" className="row row-action" onClick={() => void test()}>
        Probar
      </button>
      <p className="group-footer" role="status">
        {message ?? "Lo digo con mi voz cuando abrís la app o volvés después de un rato. En el iPhone arranca con tu primer toque: el sistema no deja que suene solo."}
      </p>
    </div>
  );
}
