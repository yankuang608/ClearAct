// SPDX-License-Identifier: MIT
/** The accepted ClearAct mark: a pointer inside an open orbit. */
export function createOrbitIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const attributes = {
    class: 'orbit-icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  const orbit = document.createElementNS(namespace, 'path');
  orbit.setAttribute('d', 'M16.8 4.6a8.3 8.3 0 1 0 3.4 7.4');
  const pointer = document.createElementNS(namespace, 'path');
  pointer.setAttribute('d', 'm8.8 6.6 9.4 6-4.5 1.3-2.5 4.7Z');
  pointer.setAttribute('fill', 'currentColor');
  pointer.setAttribute('stroke', 'none');
  const satellite = document.createElementNS(namespace, 'circle');
  satellite.setAttribute('cx', '19.4');
  satellite.setAttribute('cy', '6.2');
  satellite.setAttribute('r', '1.4');
  satellite.setAttribute('fill', 'currentColor');
  satellite.setAttribute('stroke', 'none');
  svg.append(orbit, pointer, satellite);
  return svg;
}
