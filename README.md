# Radar Hockey · NHL

Web de hockey con datos de AnnaBet.com: NHL por defecto y selector con las demás ligas de hockey
de AnnaBet (o pegar el enlace de cualquier liga). Partidos por fecha (◀ ▶), buscador, 🔥 +55%.
Por partido: posición, récord G-GP-PP-P, % ganador, % ganados en 60', PPG, tabla general + casa (local) /
fuera (visita), ganador con prórroga, 1X2 en 60 minutos (X = prórroga), goles totales (cruzado,
suma de anotados, 3 marcadores, over/under 5.5 y 6.5), hándicap A/B y puck line, y el resultado
final comparado con los cálculos. Al inicio de temporada usa la tabla de la temporada anterior.

## Estructura
- `public/index.html` — la página
- `netlify/functions/hockey.mjs` — lee AnnaBet:
  - `/api/hockey?league=serie_6_NHL` posiciones y partidos
  - `/api/hockey?part=leagues` lista de ligas
  - `/api/hockey?debug=1&league=serie_6_NHL` diagnóstico
- `netlify.toml` — configuración de Netlify (no cambiar)

## Publicar
1. Repositorio nuevo en GitHub: arrastrar las carpetas `public` y `netlify` más
   `netlify.toml`, `package.json` y `README.md`.
2. Netlify → Add new site → Import from GitHub → Deploy.
