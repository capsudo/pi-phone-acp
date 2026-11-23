{
  lib,
  buildNpmPackage,
  fetchurl,
  jq,
  nodejs_24,
}:

buildNpmPackage (finalAttrs: {
  pname = "pi-phone-acp";
  version = "3.0.0";

  src = fetchurl {
    url = "https://registry.npmjs.org/pi-phone-acp/-/pi-phone-acp-${finalAttrs.version}.tgz";
    hash = "sha256-v5r2okS05o5WncRaWf5Zf+KcdV7LGfbJ3LIqMGJ85iY=";
  };

  nodejs = nodejs_24;
  npmDepsHash = "sha256-eK32FJSDPGANKU9+dDv8KpjpbGpnLQUCmLtLk4Se3fU=";

  # npm publishes compiled dist/ files but no dependency lockfile. Remove the
  # source-only scripts and dev dependencies before applying the runtime lock.
  postPatch = ''
    ${lib.getExe jq} 'del(.devDependencies, .scripts)' package.json > package.json.tmp
    mv package.json.tmp package.json
    cp ${./package-lock.json} package-lock.json
  '';

  dontNpmBuild = true;
  npmFlags = [ "--ignore-scripts" ];
  npmInstallFlags = [ "--omit=dev" ];

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck

    node ${./smoke-test.mjs} "$out/bin/pi-phone-acp" ${lib.escapeShellArg finalAttrs.version}

    runHook postInstallCheck
  '';

  meta = {
    description = "ACP adapter for a phone-owned pi-phone agent";
    homepage = "https://github.com/capsudo/pi-phone-acp";
    license = lib.licenses.mit;
    mainProgram = "pi-phone-acp";
    platforms = lib.platforms.linux;
  };
})
