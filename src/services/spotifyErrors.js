function spotifyFailure(error) {
  const code = error.response?.data?.error;
  if (code === "invalid_grant" || error.code === "SPOTIFY_REAUTH_REQUIRED") {
    return { status: 409, body: { code: "SPOTIFY_REAUTH_REQUIRED", reauth_required: true,
      error: "Spotify ya no acepta la autorización guardada. El administrador debe volver a conectar Spotify." } };
  }
  if (code === "invalid_client") {
    return { status: 503, body: { code: "SPOTIFY_CONFIGURATION_ERROR",
      error: "Spotify rechazó la configuración de la aplicación. El administrador debe revisarla." } };
  }
  return { status: 503, body: { code: "SPOTIFY_UNAVAILABLE",
    error: "No se pudo consultar Spotify. Inténtalo de nuevo; esto no significa que la cuenta esté desconectada." } };
}
module.exports = { spotifyFailure };
