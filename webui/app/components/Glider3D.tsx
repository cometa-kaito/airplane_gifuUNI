"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { useRef, memo } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { TelemetryFrame } from "../hooks/useTelemetry";

const RAD = Math.PI / 180;

/**
 * 機体本体。React 再レンダではなく useFrame で毎 GL フレームに ref を読み取り更新する。
 * これにより親の state 変化と切り離され、姿勢更新でページが再レンダされない。
 */
function Plane({
  attitudeRef,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
}) {
  const groupRef = useRef<THREE.Group>(null!);

  useFrame(() => {
    const a = attitudeRef.current;
    if (!a || !groupRef.current) return;
    // X: ピッチ, Y: ヨー, Z: ロール の順で適用
    groupRef.current.rotation.set(
      a.pitch * RAD,
      a.yaw * RAD,
      a.roll * RAD,
    );
  });

  return (
    <group ref={groupRef}>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[0.25, 0.25, 3]} />
        <meshStandardMaterial color="#dcdfe4" />
      </mesh>
      <mesh position={[0, 0, 1.8]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.18, 0.6, 16]} />
        <meshStandardMaterial color="#f0f0f8" />
      </mesh>
      <group position={[0, 0.1, 0]}>
        <mesh position={[1.25, 0.05, 0]} rotation={[0, 0, 5 * RAD]}>
          <boxGeometry args={[2.5, 0.04, 0.8]} />
          <meshStandardMaterial color="#ffd43b" />
        </mesh>
        <mesh position={[-1.25, 0.05, 0]} rotation={[0, 0, -5 * RAD]}>
          <boxGeometry args={[2.5, 0.04, 0.8]} />
          <meshStandardMaterial color="#ffd43b" />
        </mesh>
      </group>
      <mesh position={[0, 0.05, -1.4]}>
        <boxGeometry args={[1.5, 0.04, 0.4]} />
        <meshStandardMaterial color="#ff922b" />
      </mesh>
      <mesh position={[0, 0.3, -1.4]}>
        <boxGeometry args={[0.04, 0.5, 0.4]} />
        <meshStandardMaterial color="#e03131" />
      </mesh>
    </group>
  );
}

function Axes() {
  return (
    <group>
      <arrowHelper args={[new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), 2, 0xff5555]} />
      <arrowHelper args={[new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 2, 0x55ff55]} />
      <arrowHelper args={[new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 2, 0x5555ff]} />
    </group>
  );
}

function Glider3DImpl({
  attitudeRef,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
}) {
  return (
    <div className="bg-glider-panel rounded h-96">
      <Canvas
        camera={{ position: [4, 3, 5], fov: 45 }}
        style={{ background: "#0d1117" }}
        // フレームループを継続稼働
        frameloop="always"
      >
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 8, 5]} intensity={0.8} />
        <Grid
          args={[20, 20]}
          position={[0, -1.5, 0]}
          cellColor="#2a3038"
          sectionColor="#3d4654"
          fadeDistance={20}
          fadeStrength={1}
          infiniteGrid
        />
        <Axes />
        <Plane attitudeRef={attitudeRef} />
        <OrbitControls enableDamping dampingFactor={0.1} />
      </Canvas>
    </div>
  );
}

export const Glider3D = memo(Glider3DImpl);
