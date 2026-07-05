"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { AMFLoader } from "three/examples/jsm/loaders/AMFLoader.js";
import { Loader2 } from "lucide-react";

/** Interactive WebGL preview of an uploaded model. Loaded via dynamic import
 *  (ssr:false) so three.js never enters the server bundle. Fetches the raw
 *  bytes from the model file endpoint and parses with the format's loader. */
export default function ModelViewer({
  modelId,
  format,
  wireframe,
}: {
  modelId: string;
  format: string;
  wireframe: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const materialsRef = useRef<THREE.MeshStandardMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Toggle wireframe on the live materials without rebuilding the scene.
  useEffect(() => {
    for (const m of materialsRef.current) m.wireframe = wireframe;
  }, [wireframe]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let raf = 0;
    let disposed = false;
    const width = mount.clientWidth || 400;
    const height = mount.clientHeight || 300;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1, 1.4, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-1, -0.5, -1);
    scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const frame = (object: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(object);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      object.position.sub(center);
      const radius = Math.max(size.x, size.y, size.z, 1);
      const dist = radius * 2.4;
      camera.position.set(dist * 0.8, dist * 0.6, dist * 0.9);
      camera.near = radius / 100;
      camera.far = radius * 100;
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
    };

    const material = () => {
      const m = new THREE.MeshStandardMaterial({
        color: 0xd0d4d9,
        metalness: 0.05,
        roughness: 0.75,
        wireframe,
      });
      materialsRef.current.push(m);
      return m;
    };

    const addGeometry = (geometry: THREE.BufferGeometry) => {
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, material());
      scene.add(mesh);
      frame(mesh);
    };

    const addGroup = (group: THREE.Object3D) => {
      group.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).material = material();
      });
      scene.add(group);
      frame(group);
    };

    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };

    const onResize = () => {
      const w = mount.clientWidth || width;
      const h = mount.clientHeight || height;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/models/${modelId}/file`, { signal: controller.signal });
        if (!res.ok) throw new Error(`Could not load model (HTTP ${res.status})`);
        const buffer = await res.arrayBuffer();
        if (disposed) return;

        switch (format) {
          case "stl":
            addGeometry(new STLLoader().parse(buffer));
            break;
          case "obj":
            addGroup(new OBJLoader().parse(new TextDecoder().decode(buffer)));
            break;
          case "3mf":
            addGroup(new ThreeMFLoader().parse(buffer));
            break;
          case "amf":
            addGroup(new AMFLoader().parse(buffer));
            break;
          default:
            throw new Error("Unsupported format");
        }
        setLoading(false);
        animate();
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Preview unavailable");
        setLoading(false);
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      for (const m of materialsRef.current) m.dispose();
      materialsRef.current = [];
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [modelId, format]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative h-full w-full">
      <div ref={mountRef} className="h-full w-full" />
      {loading && !error && (
        <div className="absolute inset-0 grid place-items-center text-muted">
          <Loader2 strokeWidth={1.65} className="h-6 w-6 animate-spin" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 grid place-items-center px-4 text-center text-sm text-muted">
          {error}
        </div>
      )}
    </div>
  );
}
