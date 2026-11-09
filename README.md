# PushLife (wireframe)

Personal data visualization of homes and travels: Timeline, Map, Locations and Print modes driven by one `data.json`.

- Open `index.html` through any static server (GitHub Pages works as is).
- Edit data in the page (Edit data), then Download data.json and replace the file here to publish.
- Deep links: `#mode=locations&sel=place:paris-france&spot=eiffel-tower&t=2010-05`
- Embed in Google Sites: Insert → Embed → By URL → the Pages URL.

Libraries are vendored in `lib/`: d3 7.9.0 (ISC), topojson-client 3.1.0 (ISC), world-atlas 2.0.2 countries-50m (Natural Earth, public domain; see lib/world-atlas-LICENSE). Historical weather comes from the Open-Meteo archive API at view time.
