# Plottimation Tool

[**This free tool**](https://golanlevin.github.io/plottimation/) builds a looping GIF from a scan or photograph of an animation contact-sheet. It automatically aligns the frames; works both with or without alignment markers; and can even work with casual photographs. You can find the tool [**here**](https://golanlevin.github.io/plottimation/).<br/>
Version 1.18 • By @GolanLevin, Spring 2026.

* [**Plottimation Tool Online Here**](https://golanlevin.github.io/plottimation/)
* [**Quickstart Instructions**](#quickstart-instructions)
* [**Documentation**](documentation.md)<br />—<br/>
* [p5.js Design Templates](templates/README.md)
* [Demonstration Video](https://www.youtube.com/watch?v=MOXB63DgItQ)
* [GIF Gallery](#plottimation-gif-gallery)

[![plottimation_ui.png](doc/plottimation_spinnyrect.gif)](https://golanlevin.github.io/plottimation/)

---

## Quickstart Instructions

1. **Create** a "frame sheet" of your animation. You can work in either of two ways:
   - **With Markers.** Make a marker-based sheet, with frames separated by small crosses (`+`) or filled circular dots (`●`), rendered in a high-contrast ink. [Here's a p5.js sketch](https://editor.p5js.org/golan/sketches/_ZMbagYFc) to get started. Using markers gives the most accurate frame alignment.<br/><img src="doc/marker-page-examples.png" width="400">
   - **Or, Without Markers.** Create a markerless sheet, with frames separated by empty gutters. *Note:* depending on your design, the markerless pipeline may produce more jittery animations.<br/><img src="doc/markerless-page-example.png" height="131">
   - **Or, Per-Frame.** Upload a sequence of individual images — one photo or scan per animation frame — instead of a single contact-sheet photo. Drop several images at once, or choose `Per-Frame (one image per frame)` under `Alignment Pipeline`. The bundled `11_per_frame` demo in the Load Demo menu shows this workflow with 24 separate photos.
2. **Photograph or scan** your frame sheet (or collect one image per frame for per-frame mode). It's OK to use a casual photo, but your page must have good contrast against a plain background. For example, a light-colored sheet should be completely surrounded by a uniform dark background, as shown [here](demo/1_dmawer_crosses.jpg) and below. It is *strongly recommended* to keep the resolution of your frame sheet under 8000×8000 pixels.<br/><img src="doc/page-photo-recommendations.png">
3. **Open** the [**Plottimation Tool**](https://golanlevin.github.io/plottimation/) in a browser, from [**here**](https://golanlevin.github.io/plottimation).
4. **Load** the image of your frame sheet into the Plottimation Tool. You can do this by dragging your image file onto the Tool's load target (where it says "Drop a photo or scan here"), or by clicking the target to load a file.
5. Under the *Layout* tab, **set** `Frame Columns` and `Frame Rows` to match the layout of your sheet's grid of frames. You should also set your sheet's orientation (landscape or portrait) and page size (11×8.5, etc.).
6. It's time to **detect** your page and **extract** its grid of frames. **Adjust** the `Page Detection Threshold` slider in the *Page & Grid Detection* tab until you see a bright green frame around your page in the `Page Corners` panel. You may also need to adjust other settings, such as `Grid Search Inset X` and `Grid Search Inset Y`. If your sheet uses light ink on dark paper, enable `Light-on-dark design`. If necessary you can specify the page corners manually in the Page Corners panel.<br><img src="doc/page-rectification.png" height="250">
7. **Choose** the correct `Alignment Pipeline` for your frame sheet:
   - `Markers (crosses, dots)` for marker-separated sheets, or 
   - `Markerless (gutters, frames)` for gutter-separated sheets without registration marks
8. If you select `Markerless`, you will probably want to **enable stabilization** in the *Stabilization* tab. 
9. According to your taste, **adjust** the settings under the *Appearance* and *Crop & Geometry* tabs. Changes to these settings are reflected in the animation shown in the *Preview & Export* panel.
10. To generate and download your GIF animation, **click** `↓GIF` in the *Preview & Export* panel. You can also download your animation as an MP4 movie or a zipped folder of frames. There are advanced settings in the *Export Options* tab for adjusting output dimensions, compression quality, and playback modes.
11. You can also **save** your animations' settings file to save time later; find a button for doing this at the bottom of the *Export Options* tab.

---

## Plottimation GIF Gallery

*All animations are © their respective authors, and are used in this project with permission.*

![Plot by Golan Levin (@golanlevin)](doc/2_plot_concentric.gif) 
[![2_plot_concentric_i.jpg](doc/2_plot_concentric_i.jpg)](demo/2_plot_concentric.jpg)
<br>Plot by Golan Levin (@golanlevin)

![Plot by Julien Gachadoat (@julienv3ga)](doc/4_plot_julienv3ga.gif) 
[![4_plot_julienv3ga.jpg](doc/4_plot_julienv3ga_i.jpg)](demo/4_plot_julienv3ga.jpg)
<br>Plot by Julien Gachadoat ([@julienv3ga](https://www.instagram.com/julienv3ga/))

![Intagio by Golan Levin (@golanlevin)](doc/5_intaglio_bubblewalker_3614.gif) 
[![5_intaglio_bubblewalker_3614.gif](doc/5_intaglio_bubblewalker_3614_i.jpg)](demo/5_intaglio_bubblewalker_3614_i.jpg)
<br>"Bubblewalker 3614" Intaglio by Golan Levin (@golanlevin)

![Plot by Golan Levin (@golanlevin)](doc/5_plot_bubblewalker_3626.gif) 
[![5_plot_bubblewalker_3626.gif](doc/5_plot_bubblewalker_3626_i.jpg)](demo/5_plot_bubblewalker_3628_i.jpg)
<br>"Bubblewalker 3626" Plot by Golan Levin (@golanlevin)

![Plot by Golan Levin (@golanlevin)](doc/5_plot_bubblewalker_3628.gif) 
[![5_plot_bubblewalker_3628.gif](doc/5_plot_bubblewalker_3628_i.jpg)](demo/5_plot_bubblewalker_3628_i.jpg)
<br>"Bubblewalker 3628" Plot by Golan Levin (@golanlevin)

![Riso by Alex Barsky (@zinehug)](doc/6_riso_zinehug_anim.gif) 
[![6_riso_zinehug_workshop_i.jpg](doc/6_riso_zinehug_workshop_i.jpg)](demo/6_riso_zinehug_workshop.jpg) 
<br>Risograph by Alex Barsky ([@zinehug](https://www.instagram.com/zinehug))

![Riso by Alex Barsky (@zinehug)](doc/7_riso_zinehug_clay.gif) 
[![7_riso_zinehug_clay_i.png](doc/7_riso_zinehug_clay_i.png)](demo/7_riso_zinehug_clay.png)
<br>Risograph by Alex Barsky ([@zinehug](https://www.instagram.com/zinehug))

![Riso by Zack Lydon (@zinehug)](doc/8_riso_zinehug_summoner.gif) 
[![8_riso_zinehug_summoner_i.jpg](doc/8_riso_zinehug_summoner_i.jpg)](demo/8_riso_zinehug_summoner.jpg)
<br>"Summoner" Risograph by Zack Lydon ([@zinehug](https://www.instagram.com/zinehug))

![Riso by Kelli Anderson (@kellianderson)](doc/9_riso_kellianderson.gif) 
[![9_riso_kellianderson_i.jpg](doc/9_riso_kellianderson_i.jpg)](demo/9_riso_kellianderson.jpg)
<br>"A" Risograph by Kelli Anderson ([@kellianderson](https://www.instagram.com/kellianderson/))  

![Cyanotype by Kelli Anderson (@kellianderson)](doc/10_cyano_kellianderson.gif)
[![10_cyano_kellianderson_i.png](doc/10_cyano_kellianderson_i.png)](demo/10_cyano_kellianderson.png)
<br>Cyanotype by Kelli Anderson ([@kellianderson](https://www.instagram.com/kellianderson/)) 

![Metro by David Vandenbogaerde (per-frame mode demo) (@dxviie, @d17e.dev)](doc/11_per_frame_d17e.gif)
<br>Metro by David Vandenbogaerde ([@dxviie](https://github.com/dxviie), [@d17e.dev](https://www.instagram.com/d17e.dev/))

<!-- 

References: 

* [Spectrolite Riso Animation](https://spectrolite.app/how-to/art-and-animation/riso-animation)

-->
