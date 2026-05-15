"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { useRef, memo, useState, useEffect } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { TelemetryFrame } from "../hooks/useTelemetry";
import { PlaneModel } from "./PlaneModel";
import {
  PRESET_ORDER,
  PRESETS,
  getPreset,
  type PresetKey,
} from "../lib/planeSpecs";

const RAD = Math.PI / 180;
const PRESET_STORAGE_KEY = "glider-webui:preset";

/**
 * 機体本体。React 再レンダではなく useFrame で毎 GL フレームに ref を読み取り更新する。
 */
function PlaneWithAttitude({
  attitudeRef,
  specName,
}: {
  attitudeRef: MutableRefObject<TelemetryFrame | null>;
  specName: PresetKey;
}) {
  const groupRef = useRef<THREE.Group>(null!);

  useFrame(() => {
    const a = attitudeRef.current;
    if (!a || !groupRef.current) return;
    groupRef.current.rotation.set(a.pitch * RAD, a.yaw * RAD, a.roll * RAD);
  });

  const spec = getPreset(specName);

  return (
    <group ref={groupRef}>
      <PlaneModel spec={spec} />
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

function AxisDots() {
  return (
    <group>
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
  // SSR-safe localStorage 読み込み
  const [preset, setPresetState] = useState<PresetKey>("default");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(PRESET_STORAGE_KEY);
      if (v && (PRESET_ORDER as readonly string[]).includes(v)) {
        setPresetState(v as PresetKey);
      }
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  const setPreset = (p: PresetKey) => {
    setPresetState(p);
    try {
      window.localStorage.setItem(PRESET_STORAGE_KEY, p);
    } catch {
      // ignore
    }
  };

  const currentSpec = PRESETS[preset];

  return (
    <div className="card relative overflow-hidden h-full min-h-[420px]">
      <div className="absolute top-3 left-3 z-10 flex items-center gap-3 pointer-events-auto">
        <span className="section-title">3D Attitude</span>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as PresetKey)}
          className="bg-glider-surface border border-glider-border rounded-md
                     text-xs text-glider-text font-mono
                     px-2 py-1 focus:outline-none focus:border-glider-accent
                     hover:border-glider-borderHi cursor-pointer"
          title="機体形状プリセット"
        >
          {PRESET_ORDER.map((key) => (
            <option key={key} value={key}>
              {PRESETS[key].label}
            </option>
          ))}
        </select>
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

      {hydrated && (
        <div className="absolute bottom-12 left-3 z-10 text-[10px] text-glider-textMute font-mono max-w-[60%] pointer-events-none">
          {currentSpec.description}
        </div>
      )}

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
        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 8, 5]} intensity={0.9} />
        <directionalLight position={[-5, 4, -3]} intensity={0.3} color="#5cc8ff" />
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
        <AxisDots />
        <PlaneWithAttitude attitudeRef={attitudeRef} specName={preset} />
        <OrbitControls enableDamping dampingFactor={0.1} />
      </Canvas>
    </div>
  );
}

export const Glider3D = memo(Glider3DImpl);
