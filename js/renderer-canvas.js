import { DIRECTIONS, LAYERS } from './defs.js';
import { mk } from './util.js';
import TILE_TYPES from './tiletypes.js';

export class CanvasRenderer {
    constructor(tileset, fixed_size = null) {
        this.tileset = tileset;
        // Default, unfortunately and arbitrarily, to the CC1 size of 9×9.  We
        // don't know for sure what size to use until the Game loads a level,
        // and it doesn't do that until creating a renderer!  It could be fixed
        // to do so, but then we wouldn't make a canvas so it couldn't be
        // hooked, yadda yadda
        if (fixed_size) {
            this.viewport_size_x = fixed_size;
            this.viewport_size_y = fixed_size;
        }
        else {
            this.viewport_size_x = 9;
            this.viewport_size_y = 9;
        }
        this.canvas = mk('canvas', {width: tileset.size_x * this.viewport_size_x, height: tileset.size_y * this.viewport_size_y});
        this.canvas.style.setProperty('--viewport-width', this.viewport_size_x);
        this.canvas.style.setProperty('--viewport-height', this.viewport_size_y);
        this.ctx = this.canvas.getContext('2d');
        this.viewport_x = 0;
        this.viewport_y = 0;
        this.viewport_dirty = false;
        this.show_actor_bboxes = false;
        this.use_rewind_effect = false;
        this.perception = 'normal';  // normal, xray, editor, palette
    }

    set_level(level) {
        this.level = level;
        // TODO update viewport size...  or maybe Game should do that since you might be cheating
    }

    // Change the viewport size.  DOES NOT take effect until the next redraw!
    set_viewport_size(x, y) {
        this.viewport_size_x = x;
        this.viewport_size_y = y;
        this.viewport_dirty = true;
    }

    cell_coords_from_event(ev) {
        let rect = this.canvas.getBoundingClientRect();
        let scale_x = rect.width / this.canvas.width;
        let scale_y = rect.height / this.canvas.height;
        let x = Math.floor((ev.clientX - rect.x) / scale_x / this.tileset.size_x + this.viewport_x);
        let y = Math.floor((ev.clientY - rect.y) / scale_y / this.tileset.size_y + this.viewport_y);
        return [x, y];
    }

    real_cell_coords_from_event(ev) {
        let rect = this.canvas.getBoundingClientRect();
        let scale_x = rect.width / this.canvas.width;
        let scale_y = rect.height / this.canvas.height;
        let x = (ev.clientX - rect.x) / scale_x / this.tileset.size_x + this.viewport_x;
        let y = (ev.clientY - rect.y) / scale_y / this.tileset.size_y + this.viewport_y;
        return [x, y];
    }

    // Draw to a canvas using tile coordinates
    blit(ctx, sx, sy, dx, dy, w = 1, h = w) {
        let tw = this.tileset.size_x;
        let th = this.tileset.size_y;
        ctx.drawImage(
            this.tileset.image,
            sx * tw, sy * th, w * tw, h * th,
            dx * tw, dy * th, w * tw, h * th);
    }

    _make_tileset_blitter(ctx, offsetx = 0, offsety = 0) {
        // The blit we pass to the tileset has a different signature than our own:
        // blit(
        //     source_tile_x, source_tile_y,
        //     mask_x = 0, mask_y = 0, mask_width = 1, mask_height = mask_width,
        //     mask_dx = mask_x, mask_dy = mask_y)
        // This makes it easier to use in the extremely common case of drawing part of one tile atop
        // another tile, but still aligned to the grid.
        return (tx, ty, mx = 0, my = 0, mw = 1, mh = mw, mdx = mx, mdy = my) =>
            this.blit(ctx, tx + mx, ty + my, offsetx + mdx, offsety + mdy, mw, mh);
    }

    draw(tic_offset = 0) {
        if (! this.level) {
            console.warn("CanvasRenderer.draw: No level to render");
            return;
        }

        if (this.viewport_dirty) {
            this.viewport_dirty = false;
            this.canvas.setAttribute('width', this.tileset.size_x * this.viewport_size_x);
            this.canvas.setAttribute('height', this.tileset.size_y * this.viewport_size_y);
            this.canvas.style.setProperty('--viewport-width', this.viewport_size_x);
            this.canvas.style.setProperty('--viewport-height', this.viewport_size_y);
        }

        let tic = (this.level.tic_counter ?? 0) + tic_offset;
        let tw = this.tileset.size_x;
        let th = this.tileset.size_y;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // TODO only recompute if the player moved?
        // TODO what about levels smaller than the viewport...?  shrink the canvas in set_level?
        let xmargin = (this.viewport_size_x - 1) / 2;
        let ymargin = (this.viewport_size_y - 1) / 2;
        let px, py;
        // FIXME editor vs player
        if (this.level.player) {
            [px, py] = this.level.player.visual_position(tic_offset);
        }
        else {
            [px, py] = [0, 0];
        }
        // Figure out where to start drawing
        // TODO support overlapping regions better
        let x0 = px - xmargin;
        let y0 = py - ymargin;
        // FIXME editor vs player again ugh, which is goofy since none of this is even relevant;
        // maybe need to have a separate positioning method
        if (this.level.stored_level) {
        for (let region of this.level.stored_level.camera_regions) {
            if (px >= region.left && px < region.right &&
                py >= region.top && py < region.bottom)
            {
                x0 = Math.max(region.left, Math.min(region.right - this.viewport_size_x, x0));
                y0 = Math.max(region.top, Math.min(region.bottom - this.viewport_size_y, y0));
            }
        }
        }
        // Always keep us within the map bounds
        x0 = Math.max(0, Math.min(this.level.size_x - this.viewport_size_x, x0));
        y0 = Math.max(0, Math.min(this.level.size_y - this.viewport_size_y, y0));
        // Round to the pixel grid
        x0 = Math.floor(x0 * tw + 0.5) / tw;
        y0 = Math.floor(y0 * th + 0.5) / th;
        this.viewport_x = x0;
        this.viewport_y = y0;
        // The viewport might not be aligned to the grid, so split off any fractional part.
        let xf0 = Math.floor(x0);
        let yf0 = Math.floor(y0);
        // We need to draw one cell beyond the viewport, or we'll miss objects partway through
        // crossing the border moving away from us
        if (xf0 > 0) {
            xf0 -= 1;
        }
        if (yf0 > 0) {
            yf0 -= 1;
        }
        // Find where to stop drawing.  As with above, if we're aligned to the grid, we need to
        // include the tiles just outside it, so we allow this fencepost problem to fly
        let x1 = Math.min(this.level.size_x - 1, Math.ceil(x0 + this.viewport_size_x));
        let y1 = Math.min(this.level.size_y - 1, Math.ceil(y0 + this.viewport_size_y));
        // Draw one layer at a time, so animated objects aren't overdrawn by
        // neighboring terrain
        // FIXME this is a bit inefficient when there are a lot of rarely-used layers; consider
        // instead drawing everything under actors, then actors, then everything above actors?
        // (note: will need to first fix the game to ensure everything is stacked correctly!)
        for (let layer = 0; layer < LAYERS.MAX; layer++) {
            for (let x = xf0; x <= x1; x++) {
                for (let y = yf0; y <= y1; y++) {
                    let cell = this.level.cell(x, y);
                    let tile = cell[layer];
                    if (! tile)
                        continue;

                    let vx, vy;
                    if (tile.type.is_actor &&
                        // FIXME kind of a hack for the editor, which uses bare tile objects
                        tile.visual_position)
                    {
                        // Handle smooth scrolling
                        [vx, vy] = tile.visual_position(tic_offset);
                        // Round this to the pixel grid too!
                        vx = Math.floor(vx * tw + 0.5) / tw;
                        vy = Math.floor(vy * th + 0.5) / th;
                    }
                    else {
                        // Non-actors can't move
                        vx = x;
                        vy = y;
                    }

                    // For actors (i.e., blocks), perception only applies if there's something
                    // of potential interest underneath
                    let perception = this.perception;
                    if (perception !== 'normal' && tile.type.is_actor &&
                        ! cell.some(t =>
                            t && t.type.layer < layer &&
                            ! (t.type.name === 'floor' && (t.wire_directions | t.wire_tunnel_directions) === 0)))
                    {
                        perception = 'normal';
                    }

                    this.tileset.draw(
                        tile, tic, perception,
                        this._make_tileset_blitter(this.ctx, vx - x0, vy - y0));
                }
            }
        }

        if (this.show_actor_bboxes && this.level.constructor.name === 'Level') {  // FIXME dumb hack so this doesn't happen in editor
            this.ctx.fillStyle = '#f004';
            for (let x = xf0; x <= x1; x++) {
                for (let y = yf0; y <= y1; y++) {
                    let actor = this.level.cell(x, y).get_actor();
                    if (! actor)
                        continue;
                    let [vx, vy] = actor.visual_position(tic_offset);
                    // Don't round to the pixel grid; we want to know if the bbox is misaligned!
                    this.ctx.fillRect((vx - x0) * tw, (vy - y0) * th, 1 * tw, 1 * th);
                }
            }
        }

        if (this.use_rewind_effect) {
            this.draw_rewind_effect(tic);
        }
    }

    draw_rewind_effect(tic) {
        // Shift several rows over in a recurring pattern, like a VHS, whatever that is
        let rewind_start = tic / 20 % 1;
        for (let chunk = 0; chunk < 4; chunk++) {
            let y = Math.floor(this.canvas.height * (chunk + rewind_start) / 4);
            for (let dy = 1; dy < 5; dy++) {
                this.ctx.drawImage(
                    this.canvas,
                    0, y + dy, this.canvas.width, 1,
                    -dy * dy, y + dy, this.canvas.width, 1);
            }
        }
    }

    create_tile_type_canvas(name, tile = null) {
        let canvas = mk('canvas', {width: this.tileset.size_x, height: this.tileset.size_y});
        let ctx = canvas.getContext('2d');
        // Individual tile types always reveal what they are
        this.tileset.draw_type(name, tile, 0, 'palette', this._make_tileset_blitter(ctx));
        return canvas;
    }
}

export default CanvasRenderer;
