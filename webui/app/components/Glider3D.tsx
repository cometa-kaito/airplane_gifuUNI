"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { useRef } from "react";
import * as THREE from "three";

type Attitude = { roll: number; pitch: number; yaw: number };

const RAD = Math.PI / 180;

// グライダー本体（spec を簡略化したもの。glider_templates.py の DEFAULT_GLIDER 相当）
function Plane({ attitude }: { attitude: Attitude }) {
  const ref = useRef<THREE.Group>(null!);

  useFrame(() => {
    if (!ref.current) return;
    // X: 機軸まわり=ロール、Y: 上下軸=ヨー、Z: 横軸=ピッチ
    // 機体座標：X=右翼, Y=上, Z=機首方向
    ref.current.rotation.set(
      attitude.pitch * RAD, // X 軸まわり
      attitude.yaw * RAD,   // Y 軸まわり
      attitude.roll * RAD,  // Z 軸まわり
    );
  });

  return (
    <group ref={ref}>
      {/* 胴体 */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[0.25, 0.25, 3]} />
        <meshStandardMaterial color="#dcdfe4" />
      </mesh>
      {/* 機首コーン */}
      <mesh position={[0, 0, 1.8]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.18, 0.6, 16]} />
        <meshStandardMaterial color="#f0f0f8" />
      </mesh>
      {/* 主翼（黄色、上反角5°模擬：少し V 字に2分割） */}
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
      {/* 水平尾翼 */}
      <mesh position={[0, 0.05, -1.4]}>
        <boxGeometry args={[1.5, 0.04, 0.4]} />
        <meshStandardMaterial color="#ff922b" />
      </mesh>
      {/* 垂直尾翼 */}
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
      {/* 赤=X, 緑=Y, 青=Z */}
      <arrowHelper
        args={[
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 0, 0),
          2,
          0xff5555,
        ]}
      />
      <arrowHelper
        args={[
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 0),
          2,
          0x55ff55,
        ]}
      />
      <arrowHelper
        args={[
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(0, 0, 0),
          2,
          0x5555ff,
        ]}
      />
    </group>
  );
}

export function Glider3D({ attitude }: { attitude: Attitude }) {
  return (
    <div className="bg-glider-panel rounded h-96">
      <Canvas
        camera={{ position: [4, 3, 5], fov: 45 }}
        style={{ background: "#0d1117" }}
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
        <Plane attitude={attitude} />
        <OrbitControls enableDamping dampingFactor={0.1} />
      </Canvas>
    </div>
  );
}
