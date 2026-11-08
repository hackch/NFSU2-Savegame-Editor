import { EditorController } from './controller/editor-controller.js';
import { nfsuFileChange } from './controller/file-change.js';
import { nfsuRangeChange } from './controller/range-change.js';
import { nfsuDynoCurve } from './controller/dyno-curve.js';

angular
  .module('nfsu2Editor', [])
  .directive('nfsuFileChange', nfsuFileChange)
  .directive('nfsuRangeChange', nfsuRangeChange)
  .directive('nfsuDynoCurve', nfsuDynoCurve)
  .controller('EditorController', ['$scope', EditorController]);
