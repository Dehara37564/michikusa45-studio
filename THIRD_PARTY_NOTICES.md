# Third-Party Software Notices

道草45 Studio includes third-party software. Those components are licensed by
their respective copyright holders under the terms shown below. The proprietary
license for 道草45 Studio does not replace or restrict these third-party terms.

## ts-ebml 3.0.2

Source: https://github.com/legokichi/ts-ebml

Author metadata: legokichi duckscallion

The distributed file `public/vendor/EBML.min.js` is derived from ts-ebml and
contains browser-bundled dependencies used by ts-ebml, including Buffer-related
utilities, events, int64-buffer, ebml-block, and matroska-schema. These works are
distributed under permissive open-source licenses. Their notices must be
retained when the vendored bundle is replaced or regenerated.

ts-ebml is licensed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Electron and Chromium

Electron and Chromium components are included in packaged distributions.
Electron's `LICENSE` and Chromium's `LICENSES.chromium.html`, generated with the
Electron distribution, form part of these notices and must not be removed.

The `ffmpeg.dll` supplied by Electron is an Electron/Chromium media component.
It is not the separately distributed FFmpeg command-line executable previously
used by this project.

Sources:

- https://github.com/electron/electron
- https://www.chromium.org/audio-video/

## React and React DOM

Copyright (c) Meta Platforms, Inc. and affiliates.

Source: https://github.com/facebook/react

React and React DOM are licensed under the MIT License reproduced above.

## Vite and Electron Forge

Sources:

- https://github.com/vitejs/vite
- https://github.com/electron/forge

These projects are distributed under the MIT License reproduced above. Their
individual copyright notices and the notices of bundled transitive dependencies
must be retained in release artifacts.

## Release-process requirement

Before each public release, generate a license inventory from the exact locked
dependencies and inspect the final `npm run make` artifacts. Update this file if
dependency names, versions, licenses, or bundled files have changed.
