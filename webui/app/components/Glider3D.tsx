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
    groupRef.current.rotation.set(
      a.pitch * RAD,
      a.yaw * RAD,
      a.roll * RAD,
    );
  });

  return (
    <group ref={groupRef}>
      <mesh position={[0, 0, 0]} castShadow>
        <boxGeometry args={[0.25, 0.25, 3]} />
        <meshStandardMaterial color="#e2e8f0" metalness={0.3} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0, 1.8]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <coneGeometry args={[0.18, 0.6, 16]} />
        <meshStandardMaterial color="#f8fafc" metalness={0.3} roughness={0.5} />
      </mesh>
      <group position={[0, 0.1, 0]}>
        <mesh position={[1.25, 0.05, 0]} rotation={[0, 0, 5 * RAD]} castShadow>
          <boxGeometry args={[2.5, 0.04, 0.8]} />
          <meshStandardMaterial color="#ffd43b" metalness={0.2} roughness={0.5} />
        </mesh>
        <mesh position={[-1.25, 0.05, 0]} rotation={[0, 0, -5 * RAD]} castShadow>
          <boxGeometry args={[2.5, 0.04, 0.8]} />
          <meshStandardMaterial color="#ffd43b" metalness={0.2} roughness={0.5} />
        </mesh>
      </group>
      <mesh position={[0, 0.05, -1.4]} castShadow>
        <boxGeometry args={[1.5, 0.04, 0.4]} />
        <meshStandardMaterial color="#ff922b" metalness={0.2} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.3, -1.4]} castShadow>
        <boxGeometry args={[0.04, 0.5, 0.4]} />
        <meshStandardMaterial color="#e03131" metalness={0.2} roughness={0.5} />
      </mesh>
    </group>
  );
}

function Axes() {
  return (
    <group>
      <arrowHelper args={[new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), 2, 0xff5d6c]} />
      <arrowHelper args={[new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 2, 0x3ddc97]} />
      <arrowHelper args={[new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 2, 0x5cc8ff]} />
    </group>
  );
}

function AxisLabels() {
  return (
    <group>
      {/* No textGeometry to keep deps small — small spheres for legend reference */}
      <mesh position={[2.2, 0, 0]}>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshBasicMaterial color="#ff5d6c" />
      </mesh>
      <mesh position={[0, 2.2, 0]}>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshBasicMaterial color="#3ddc97" />
      </mesh>
      <mesh position={[0, 0, 2.2]}>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshBasicMaterial color="#5cc8ff" />
      </mesh>
    </group>
  );
}

function Glider3DImpl({
  attitudeRef,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
}) {
  return (
    <div className="card relative overflow-hidden h-full min-h-[360px]">
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 pointer-events-none">
        <span className="section-title">3D Attitude</span>
      </div>
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1 text-[10px] font-mono pointer-events-none">
        <span className="flex items-center gap-1.5 text-glider-roll">
          <i className="inline-block w-2 h-2 rounded-sm bg-glider-roll" /> X / Roll
        </span>
        <span className="flex items-center gap-1.5 text-glider-pitch">
          <i className="inline-block w-2 h-2 rounded-sm bg-glider-pitch" /> Y / Yaw axis
        </span>
        <span className="flex items-center gap-1.5 text-glider-yaw">
          <i className="inline-block w-2 h-2 rounded-sm bg-glider-yaw" /> Z / Pitch axis
        </span>
      </div>
      <div className="absolute bottom-2 right-3 z-10 text-[10px] text-glider-textMute font-mono pointer-events-none">
        drag to orbit · scroll to zoom
      </div>

      <Canvas
        camera={{ position: [4, 3, 5], fov: 45 }}
        style={{
          background:
            "radial-gradient(ellipse at 50% 30%, #0e1726 0%, #060912 70%)",
        }}
        frameloop="always"
      >
        <ambientLight intensity={0.45} />
        <directionalLight position={[5, 8, 5]} intensity={0.9} />
        <directionalLight position={[-5, 4, -3]} intensity={0.25} color="#5cc8ff" />
        <Grid
          args={[20, 20]}
          position={[0, -1.5, 0]}
          cellColor="#1f2937"
          sectionColor="#334155"
          fadeDistance={20}
          fadeStrength={1}
          infiniteGrid
        />
        <Axes />
        <AxisLabels />
        <Plane attitudeRef={attitudeRef} />
        <OrbitControls enableDamping dampingFactor={0.1} />
      </Canvas>
    </div>
  );
}

export const Glider3D = memo(Glider3DImpl);
