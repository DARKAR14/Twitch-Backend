// prohibidas.js - Lista de palabras prohibidas
const palabrasProhibidas = ['nigger', 'nigga', 'niga', 'negro', 'nigg3r', 'n1gga'];

function censurar(texto) {
  let resultado = texto;
  palabrasProhibidas.forEach(palabra => {
    const regex = new RegExp(palabra, 'gi');
    resultado = resultado.replace(regex, '***');
  });
  return resultado;
}

module.exports = { palabrasProhibidas, censurar };
