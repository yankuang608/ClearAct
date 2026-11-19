import {test} from "node:test";
import assert from "node:assert/strict";
import {cursorDuration,cursorPoint} from "../src/cursor-motion.ts";

// An unbounded distance-based duration would make long actions wait too long.
test("cursor travel remains readable and bounded at both distance extremes",()=>{
 assert.equal(cursorDuration({x:0,y:0},{x:0,y:0}),400);
 assert.ok(cursorDuration({x:0,y:0},{x:100,y:0})>=400);
 assert.ok(cursorDuration({x:0,y:0},{x:100,y:0})<cursorDuration({x:0,y:0},{x:600,y:0}));
 assert.equal(cursorDuration({x:0,y:0},{x:10000,y:0}),650);
});
// Snapping, linear timing, or losing the endpoint would break these trajectories.
test("cursor follows an eased curve and reaches the exact target",()=>{
 const from={x:10,y:20},to={x:1010,y:20};
 assert.deepEqual(cursorPoint(from,to,0),from);
 assert.deepEqual(cursorPoint(from,to,1),to);
 assert.deepEqual(cursorPoint(from,to,2),to);
 const early=cursorPoint(from,to,.1),middle=cursorPoint(from,to,.5),late=cursorPoint(from,to,.9);
 assert.ok(early.x>10 && early.x<110,"ease-in travels less than 10% initially");
 assert.ok(middle.x>early.x && middle.x<late.x);
 assert.ok(middle.y<20 && middle.y>0,"curve remains a slight offset");
 assert.ok(late.x>910 && late.x<1010,"ease-out approaches the endpoint");
 assert.deepEqual(cursorPoint(from,from,.5),from);
});
