"use client";

import { useMemo } from "react";
import * as THREE from "three";
import type {
  PlaneSpec,
  WingSpec,
  TailSpec,
  VTailSpec,
} from "../lib/planeSpecs";

const RAD = Math.PI / 180;

/**
 * 翼の半身を BufferGeometry で構築する。
 * 形状: 台形の薄い板 (top/bottom + 4辺 = 12 三角形)
 *  - X 方向: 翼幅 (0 が根本、+halfSpan が翼端)
 *  - Y 方向: 板厚
 *  - Z 方向: 翼弦 (-chord/2 が後縁、+chord/2 が前縁)
 */
function buildHalfWingGeometry(
  halfSpan: number,
  chordRoot: number,
  chordTip: number,
  sweepDeg: number,
  thickness: number,
): THREE.BufferGeometry {
  const sweepOffset = halfSpan * Math.tan(sweepDeg * RAD);
  const t = thickness / 2;

  // prettier-ignore
  const positions = new Float32Array([
    // Top
    0,         t,  chordRoot / 2,                  // 0: root LE
    halfSpan,  t,  chordTip / 2 - sweepOffset,     // 1: tip LE
    halfSpan,  t, -chordTip / 2 - sweepOffset,     // 2: tip TE
    0,         t, -chordRoot / 2,                  // 3: root TE
    // Bottom
    0,        -t,  chordRoot / 2,                  // 4
    halfSpan, -t,  chordTip / 2 - sweepOffset,     // 5
    halfSpan, -t, -chordTip / 2 - sweepOffset,     // 6
    0,        -t, -chordRoot / 2,                  // 7
  ]);

  // prettier-ignore
  const indices = new Uint16Array([
    // Top (ccw seen from +Y)
    0, 1, 2,   0, 2, 3,
    // Bottom (reverse)
    4, 6, 5,   4, 7, 6,
    // Leading edge
    0, 4, 5,   0, 5, 1,
    // Trailing edge
    2, 6, 7,   2, 7, 3,
    // Tip
    1, 5, 6,   1, 6, 2,
    // Root
    0, 3, 7,   0, 7, 4,
  ]);

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeVertexNormals();
  return g;
}

/**
 * 垂直尾翼 (X-Y 平面で立つ板)
 * 矩形の薄い板。後ろから見て上下に伸びる。
 */
function buildVTailGeometry(
  height: number,
  chord: number,
  thickness: number,
): THREE.BufferGeometry {
  const t = thickness / 2;
  // prettier-ignore
  const positions = new Float32Array([
    // +X side
     t, 0,         chord / 2,    // 0
     t, height,    chord / 2,    // 1
     t, height,   -chord / 2,    // 2
     t, 0,        -chord / 2,    // 3
    // -X side
    -t, 0,         chord / 2,    // 4
    -t, height,    chord / 2,    // 5
    -t, height,   -chord / 2,    // 6
    -t, 0,        -chord / 2,    // 7
  ]);

  // prettier-ignore
  const indices = new Uint16Array([
    // +X face
    0, 1, 2,   0, 2, 3,
    // -X face (reverse)
    4, 6, 5,   4, 7, 6,
    // Top
    1, 5, 6,   1, 6, 2,
    // Bottom
    0, 3, 7,   0, 7, 4,
    // LE (+Z)
    0, 4, 5,   0, 5, 1,
    // TE (-Z)
    2, 6, 7,   2, 7, 3,
  ]);

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeVertexNormals();
  return g;
}

function HalfWing({
  side,
  halfSpan,
  chordRoot,
  chordTip,
  sweepDeg,
  dihedralDeg,
  thickness,
  color,
  position,
}: {
  side: 1 | -1;
  halfSpan: number;
  chordRoot: number;
  chordTip: number;
  sweepDeg: number;
  dihedralDeg: number;
  thickness: number;
  color: string;
  position: [number, number, number];
}) {
  const geometry = useMemo(
    () =>
      buildHalfWingGeometry(halfSpan, chordRoot, chordTip, sweepDeg, thickness),
    [halfSpan, chordRoot, chordTip, sweepDeg, thickness],
  );
  const dihedral = dihedralDeg * RAD;
  return (
    <mesh
      geometry={geometry}
      position={position}
      rotation={[0, 0, dihedral]}
      scale={[side, 1, 1]}
    >
      <meshStandardMaterial
        color={color}
        metalness={0.15}
        roughness={0.55}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function Wing({
  spec,
  thickness = 0.05,
  posOffset = [0, 0, 0],
}: {
  spec: WingSpec;
  thickness?: number;
  posOffset?: [number, number, number];
}) {
  const halfSpan = spec.span / 2;
  return (
    <group
      position={[
        posOffset[0],
        spec.posY + posOffset[1],
        spec.posZ + posOffset[2],
      ]}
    >
      <HalfWing
        side={1}
        halfSpan={halfSpan}
        chordRoot={spec.chordRoot}
        chordTip={spec.chordTip}
        sweepDeg={spec.sweepDeg}
        dihedralDeg={spec.dihedralDeg}
        thickness={thickness}
        color={spec.color}
        position={[0, 0, 0]}
      />
      <HalfWing
        side={-1}
        halfSpan={halfSpan}
        chordRoot={spec.chordRoot}
        chordTip={spec.chordTip}
        sweepDeg={spec.sweepDeg}
        dihedralDeg={spec.dihedralDeg}
        thickness={thickness}
        color={spec.color}
        position={[0, 0, 0]}
      />
    </group>
  );
}

function HTail({ spec, thickness = 0.04 }: { spec: TailSpec; thickness?: number }) {
  const halfSpan = spec.span / 2;
  return (
    <group position={[0, spec.posY, spec.posZ]}>
      <HalfWing
        side={1}
        halfSpan={halfSpan}
        chordRoot={spec.chord}
        chordTip={spec.chord}
        sweepDeg={spec.sweepDeg}
        dihedralDeg={0}
        thickness={thickness}
        color={spec.color}
        position={[0, 0, 0]}
      />
      <HalfWing
        side={-1}
        halfSpan={halfSpan}
        chordRoot={spec.chord}
        chordTip={spec.chord}
        sweepDeg={spec.sweepDeg}
        dihedralDeg={0}
        thickness={thickness}
        color={spec.color}
        position={[0, 0, 0]}
      />
    </group>
  );
}

function VTail({ spec, thickness = 0.04 }: { spec: VTailSpec; thickness?: number }) {
  const geometry = useMemo(
    () => buildVTailGeometry(spec.height, spec.chord, thickness),
    [spec.height, spec.chord, thickness],
  );
  return (
    <mesh geometry={geometry} position={[0, spec.posY, spec.posZ]}>
      <meshStandardMaterial
        color={spec.color}
        metalness={0.15}
        roughness={0.55}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function Fuselage({
  length,
  width,
  height,
  color,
}: {
  length: number;
  width: number;
  height: number;
  color: string;
}) {
  return (
    <mesh position={[0, 0, 0]} castShadow>
      <boxGeometry args={[width, height, length]} />
      <meshStandardMaterial color={color} metalness={0.3} roughness={0.55} />
    </mesh>
  );
}

function Nose({
  length,
  radius,
  fuselageLength,
  color,
}: {
  length: number;
  radius: number;
  fuselageLength: number;
  color: string;
}) {
  return (
    <mesh
      position={[0, 0, fuselageLength / 2 + length / 2]}
      rotation={[Math.PI / 2, 0, 0]}
      castShadow
    >
      <coneGeometry args={[radius, length, 18]} />
      <meshStandardMaterial color={color} metalness={0.3} roughness={0.5} />
    </mesh>
  );
}

/**
 * パラメトリックな機体モデル。PlaneSpec を受け取って動的に各パーツを生成。
 */
export function PlaneModel({ spec }: { spec: PlaneSpec }) {
  return (
    <group>
      <Fuselage
        length={spec.fuselage.length}
        width={spec.fuselage.width}
        height={spec.fuselage.height}
        color={spec.fuselage.color}
      />
      {spec.nose && (
        <Nose
          length={spec.nose.length}
          radius={spec.nose.radius}
          fuselageLength={spec.fuselage.length}
          color={spec.nose.color}
        />
      )}
      {spec.wing && <Wing spec={spec.wing} />}
      {spec.wing && spec.wing2 && (
        <Wing
          spec={spec.wing}
          posOffset={[0, spec.wing2.offsetY, spec.wing2.offsetZ]}
        />
      )}
      {spec.htail && <HTail spec={spec.htail} />}
      {spec.vtail && <VTail spec={spec.vtail} />}
      {spec.canard && <HTail spec={spec.canard} />}
    </group>
  );
}
